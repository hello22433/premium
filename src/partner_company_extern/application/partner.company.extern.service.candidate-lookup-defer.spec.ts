// 실제 DB 연결 없는 단위 테스트이므로 typeorm-transactional 데코레이터를 no-op으로 mock한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { SsgInsertStateService } from '../../delivery/application/ssg-insert-state.service';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { SsgCheckNotFoundError, SsgProcessingError, SsgTryError } from '../infra/ssg.issue';
import { PartnerCompanyExternService } from './partner.company.extern.service';

/**
 * barCode 없는 건의 **후보 PIN 조회 실패**가 보류 시그널로 전파되는지
 * (`plans/2026-08-03-pin-issue-retry-wiring.md` §4.2, 리뷰 지적 1).
 *
 * `issue()` 는 barCode 가 없으면 `ssg_issue_log` 후보(직전 시도 PIN)를 cust_info 로 확인해
 * 재사용/보류/새발급을 정한다. 이때 조회가 실패하면 `uncertain=true` 로 모았다가 마지막에 던지는데,
 * 종전에는 원인 불문 `SsgProcessingError` 였다. 배치의 보류 판정은 `SsgTryError` 만 보므로
 * **조회 실패 건이 pass 1 에서도 `FAIL`·환불 경로로 빠졌다.**
 *
 * 두 경우를 구분해야 한다:
 *  - SSG 가 "처리중" 이라고 **정상 응답** → 몇 초 뒤 재조회해도 답이 같다 → `SsgProcessingError`
 *  - 조회 자체가 **실패** → 답을 못 받았을 뿐이다 → `SsgTryError` (pass 2 재시도 대상)
 *
 * 그리고 루프 중간에 던지면 안 된다 — 다른 후보가 등록 확정이면 **재사용이 우선**이기 때문이다.
 */
describe('PartnerCompanyExternService.issue — 후보 조회 실패의 보류 전파', () => {
  let sut: PartnerCompanyExternService;
  let ssgIssue: { check: jest.Mock; issue: jest.Mock; generateSsgIssue: jest.Mock; getTry: jest.Mock };
  let ssgIssueLogRepository: any;

  const makeRepoMock = () => ({
    create: jest.fn(),
    save: jest.fn(),
    insert: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    softDelete: jest.fn(),
    count: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    query: jest.fn(),
  });

  const tryOut = (tryYn: 'Y' | 'N') => ({
    response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ vno: ['x'], tryYn: [tryYn] }] },
  });

  const buildSsgEvent = (): SsgEventEntity =>
    ({
      id: 42,
      code: 'EK1',
      no: 'EV1',
      order: 1,
      name: '테스트 행사',
      startAt: new Date(),
      endAt: new Date(),
      couponExpiration: 30,
      eventPrice: 1000000,
      eventBalance: 1000000,
    }) as SsgEventEntity;

  /** barCode 없음 → 후보 분기로 들어간다. */
  const buildOrderDelivery = (): OrderDeliveryEntity =>
    ({
      id: 9001,
      transactionId: 'ENM-SSG-9001',
      deliveryTarget: 'encrypted-target',
      barCode: null,
      personalCode: null,
      ssgTransactionId: null,
      couponNum: null,
      expireAt: null,
      encourageAt: null,
      orderProductMapping: {
        sendContent: 'hello',
        sendTailText: '',
        fromPhoneNumber: null,
        encourageDay: null,
        product: {
          type: 'COUPON',
          name: 'SSG 테스트 상품',
          price: 5000,
          expireDay: 30,
          partnerCompanyCode: 'TEST-SSG',
          partnerCompany: { type: 'SSG' },
        },
      },
    }) as unknown as OrderDeliveryEntity;

  beforeEach(async () => {
    jest.clearAllMocks();

    ssgIssue = {
      check: jest.fn(),
      issue: jest.fn().mockResolvedValue({ response: { result: [{ code: ['1000'], reason: ['ok'] }] } }),
      generateSsgIssue: jest.fn().mockReturnValue({ barCode: '80000001', personalCode: '01312345678' }),
      getTry: jest.fn().mockResolvedValue(tryOut('N')),
    };

    ssgIssueLogRepository = { ...mock<Repository<SsgIssueLogEntity>>(), ...makeRepoMock() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerCompanyExternService,
        { provide: 'IGalaxia', useValue: mock<any>() },
        { provide: 'IGsmbiz', useValue: mock<any>() },
        { provide: 'IGiftiel', useValue: mock<any>() },
        { provide: 'IGiftiShow', useValue: mock<any>() },
        { provide: 'ICulture', useValue: mock<any>() },
        { provide: 'ISsgIssue', useValue: ssgIssue },
        { provide: 'IDaou', useValue: mock<any>() },
        {
          provide: getRepositoryToken(OrderDeliveryEntity),
          useValue: { ...mock<Repository<OrderDeliveryEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(PartnerCompanyExternHistoryEntity),
          useValue: { ...mock<Repository<PartnerCompanyExternHistoryEntity>>(), ...makeRepoMock() },
        },
        { provide: getRepositoryToken(PartnerCompanyEntity), useValue: makeRepoMock() },
        {
          provide: getRepositoryToken(PinIssueDedupEntity),
          useValue: { ...mock<Repository<PinIssueDedupEntity>>(), ...makeRepoMock() },
        },
        { provide: getRepositoryToken(SsgIssueLogEntity), useValue: ssgIssueLogRepository },
        { provide: getRepositoryToken(GiftielExchangeHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GalaxiaBarcodeLogEntity), useValue: makeRepoMock() },
        { provide: CryptoCipher, useValue: { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000') } },
        {
          provide: SsgInsertStateService,
          useValue: {
            getState: jest.fn(),
            markAttempted: jest.fn(),
            markConfirmed: jest.fn().mockResolvedValue(true),
            markFailed: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: getRepositoryToken(SsgResendDeductPendingEntity), useValue: {} },
      ],
    }).compile();

    sut = module.get(PartnerCompanyExternService);
  });

  it('후보 조회가 실패하면 SsgTryError 로 전파한다 — 배치 pass 1 이 보류로 인식해야 한다', async () => {
    // 후보 1건(직전 시도 PIN)이 있고 그 조회가 실패한다.
    ssgIssueLogRepository.find.mockResolvedValue([
      { id: 1, barCode: '80000009', personalCode: '01399999999', eventNo: null, eventSeq: null },
    ]);
    ssgIssue.getTry.mockRejectedValue(new SsgTryError('알 수 없는 오류입니다.'));

    const error = await sut.issue(buildOrderDelivery(), buildSsgEvent()).catch((e) => e);

    // SsgProcessingError 로 던지면 배치가 즉시 FAIL·환불로 보낸다(리뷰 지적 1).
    expect(error).toBeInstanceOf(SsgTryError);
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });

  it('SSG 가 "처리중" 이라고 정상 응답한 경우는 종전대로 SsgProcessingError — 재조회해도 답이 같다', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([
      { id: 1, barCode: '80000009', personalCode: '01399999999', eventNo: 'EV1', eventSeq: 1 },
    ]);
    // 제출 이력은 있는데(Y) cust_info_result 에 아직 안 옮겨진 상태 = PROCESSING.
    // 실제 SsgIssue.check() 는 code≠1001(8021=데이터 없음)이면 SsgCheckNotFoundError 를 던지고,
    // classifySsgPin 은 **그 예외를 받았을 때만** PROCESSING 으로 판정한다(`:171-175`).
    // check 를 mock 으로 대체할 때 8021 응답 객체를 resolve 하면 resultCd 가 undefined 라
    // REGISTERED 로 떨어져 재사용 성공으로 끝난다 — 반드시 reject 해야 이 경로를 탄다.
    ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
    ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('데이터 없음(8021)'));

    const error = await sut.issue(buildOrderDelivery(), buildSsgEvent()).catch((e) => e);

    expect(error).toBeInstanceOf(SsgProcessingError);
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });

  it('조회 실패 후보가 있어도 다른 후보가 등록 확정이면 재사용이 우선이다 — 루프 중간 throw 금지', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([
      { id: 2, barCode: '80000002', personalCode: '01300000002', eventNo: 'EV1', eventSeq: 1 },
      { id: 1, barCode: '80000001', personalCode: '01300000001', eventNo: 'EV1', eventSeq: 1 },
    ]);
    // 첫 후보는 조회 실패, 두 번째 후보는 등록 확정.
    ssgIssue.getTry
      .mockRejectedValueOnce(new SsgTryError('알 수 없는 오류입니다.'))
      .mockResolvedValueOnce(tryOut('Y'));
    ssgIssue.check.mockResolvedValue({
      response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ resultCd: ['0000'] }] },
    });

    const error = await sut.issue(buildOrderDelivery(), buildSsgEvent()).catch((e) => e);

    // 조회 실패를 즉시 던졌다면 재사용 가능한 PIN 을 놓치고 보류가 됐을 것이다.
    expect(error).not.toBeInstanceOf(SsgTryError);
    expect(error).not.toBeInstanceOf(SsgProcessingError);
    // 재사용이므로 새 발급(INSERT)은 하지 않는다.
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });
});
