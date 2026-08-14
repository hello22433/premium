import { PartnerSettleFeatureFlag } from '../../partner_settle/application/partner.settle.feature.flag';
import { PartnerSettleProducerService } from '../../partner_settle/application/partner.settle.producer.service';
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
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { SsgCheckNotFoundError, SsgIssueUnknownError, SsgTryError } from '../infra/ssg.issue';
import { PartnerCompanyExternService } from './partner.company.extern.service';

/**
 * barCode 없는 건의 **후보 PIN 조회 실패**가 보류 시그널로 전파되는지
 * (`plans/2026-08-03-pin-issue-retry-wiring.md` §4.2, 리뷰 지적 1).
 *
 * `issue()` 는 barCode 가 없으면 `ssg_issue_log` 후보(직전 시도 PIN)를 cust_info 로 확인해
 * P24에서는 네트워크·파싱 실패와 공식 계약으로 확인되지 않은 미존재/처리중 응답을 모두
 * `UNKNOWN`으로 합성한다. 또한 등록 확정 후보 하나와 UNKNOWN 후보가 섞여도 긍정 결과가
 * 불확실성을 덮지 못하므로 전체 판정은 UNKNOWN이어야 한다.
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
        { provide: getRepositoryToken(PinIssueCommandEntity), useValue: makeRepoMock() },
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
        { provide: PartnerSettleFeatureFlag, useValue: { isEnabled: false, isEnabledFor: () => false } },
        { provide: PartnerSettleProducerService, useValue: {} },
      ],
    }).compile();

    sut = module.get(PartnerCompanyExternService);
  });

  it('후보 조회가 실패하면 SsgIssueUnknownError로 보류하고 새 INSERT를 차단한다', async () => {
    // 후보 1건(직전 시도 PIN)이 있고 그 조회가 실패한다.
    ssgIssueLogRepository.find.mockResolvedValue([
      { id: 1, barCode: '80000009', personalCode: '01399999999', eventNo: null, eventSeq: null },
    ]);
    ssgIssue.getTry.mockRejectedValue(new SsgTryError('알 수 없는 오류입니다.'));

    const error = await sut.issue(buildOrderDelivery(), buildSsgEvent()).catch((e) => e);

    expect(error).toBeInstanceOf(SsgIssueUnknownError);
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });

  it('공식 계약이 없는 8021 응답도 SsgIssueUnknownError로 보류한다', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([
      { id: 1, barCode: '80000009', personalCode: '01399999999', eventNo: 'EV1', eventSeq: 1 },
    ]);
    // 제출 이력은 있지만 8021을 NOT_ISSUED/PROCESSING으로 확정할 공식 계약은 아직 없다.
    ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
    ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('데이터 없음(8021)'));

    const error = await sut.issue(buildOrderDelivery(), buildSsgEvent()).catch((e) => e);

    expect(error).toBeInstanceOf(SsgIssueUnknownError);
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });

  it('등록 확정 후보와 조회 실패 후보가 섞이면 전체를 UNKNOWN으로 보류한다', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([
      { id: 2, barCode: '80000002', personalCode: '01300000002', eventNo: 'EV1', eventSeq: 1 },
      { id: 1, barCode: '80000001', personalCode: '01300000001', eventNo: 'EV1', eventSeq: 1 },
    ]);
    // 첫 후보는 조회 실패, 두 번째 후보는 등록 확정.
    ssgIssue.getTry.mockRejectedValueOnce(new SsgTryError('알 수 없는 오류입니다.')).mockResolvedValueOnce(tryOut('Y'));
    ssgIssue.check.mockResolvedValue({
      response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ resultCd: ['0000'] }] },
    });

    const error = await sut.issue(buildOrderDelivery(), buildSsgEvent()).catch((e) => e);

    expect(error).toBeInstanceOf(SsgIssueUnknownError);
    // 혼합 판정이므로 후보 재사용과 새 INSERT를 모두 금지한다.
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });
});
