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
import { MarkAttemptedResult } from '../../delivery/interface/ssg.insert.state';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { SsgPinVerdict } from '../interface/ssg.issue';
import { SsgProcessingError } from '../infra/ssg.issue';
import { PartnerCompanyExternService } from './partner.company.extern.service';

/**
 * issue() SSG 분기의 barCode-empty cust_info 후보 재조회(결정점 단일화) 회귀 테스트.
 * (ralplan G001 / AC1·AC2·AC3·AC5)
 *
 * 1차 발송 실패가 tx 롤백으로 order_delivery.barCode 를 남기지 못한 고아 케이스에서,
 * issue() 가 ssg_issue_log 후보를 cust_info 진실원천으로 분류해 재사용/보류/새발급을 결정한다.
 * eventSeq 있는 후보는 classifySsgPin(등록/처리중/미제출/등록실패) — spy 로 verdict 제어.
 * eventSeq 없는 legacy 후보는 ssgIssue.getTry(제출여부)로 보류 판단.
 */
describe('PartnerCompanyExternService - issue() SSG barCode-empty 후보 재조회', () => {
  let sut: PartnerCompanyExternService;
  let ssgIssue: { check: jest.Mock; issue: jest.Mock; generateSsgIssue: jest.Mock; getTry: jest.Mock };
  let ssgIssueLogRepository: jest.Mocked<Repository<SsgIssueLogEntity>>;
  let orderDeliveryRepository: any;
  let resendDeductPendingRepository: any;
  let pendingQb: any;
  let ssgInsertStateService: {
    getState: jest.Mock;
    markAttempted: jest.Mock;
    markConfirmed: jest.Mock;
    markFailed: jest.Mock;
    restoreConfirmedPinFromIssueLog: jest.Mock;
  };

  const tryOut = (tryYn: 'Y' | 'N') => ({
    response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ vno: ['x'], tryYn: [tryYn] }] },
  });

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

  const buildSsgEvent = (): SsgEventEntity =>
    ({
      id: 42,
      code: 'EK1',
      no: 'EV1',
      order: 1,
      name: '행사',
      startAt: new Date(),
      endAt: new Date(),
      couponExpiration: 30,
      eventPrice: 1000000,
      eventBalance: 1000000,
    }) as SsgEventEntity;

  const buildOrderDelivery = (overrides: Partial<any> = {}): OrderDeliveryEntity =>
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
          name: 'SSG',
          price: 5000,
          expireDay: 30,
          partnerCompanyCode: 'TEST-SSG',
          partnerCompany: { type: 'SSG' },
        },
      },
      ...overrides,
    }) as unknown as OrderDeliveryEntity;

  const buildCandidate = (overrides: Partial<any> = {}): SsgIssueLogEntity =>
    ({
      id: 1,
      orderDeliveryId: 9001,
      barCode: '8EXIST01',
      personalCode: '01300001234',
      ssgTransactionId: 'TR-EXIST',
      eventNo: 'EV1',
      eventSeq: 1,
      ssgEventId: 42,
      couponNum: null,
      insertedAt: new Date(),
      expireAt: new Date(),
      encourageAt: null,
      ...overrides,
    }) as unknown as SsgIssueLogEntity;

  beforeEach(async () => {
    jest.clearAllMocks();
    ssgIssue = {
      check: jest.fn(),
      issue: jest.fn().mockResolvedValue({ response: { result: [{ code: ['1000'], reason: ['ok'] }] } }),
      generateSsgIssue: jest.fn().mockReturnValue({ barCode: '80000001', personalCode: '01312345678' }),
      getTry: jest.fn().mockResolvedValue(tryOut('N')),
    };
    ssgIssueLogRepository = { ...mock<Repository<SsgIssueLogEntity>>(), ...makeRepoMock() } as unknown as jest.Mocked<
      Repository<SsgIssueLogEntity>
    >;
    orderDeliveryRepository = { ...mock<Repository<OrderDeliveryEntity>>(), ...makeRepoMock() };
    ssgInsertStateService = {
      getState: jest.fn(),
      markAttempted: jest.fn().mockResolvedValue(MarkAttemptedResult.TRANSITIONED),
      markConfirmed: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(true),
      restoreConfirmedPinFromIssueLog: jest.fn().mockResolvedValue(false),
    };

    pendingQb = {
      update: jest.fn(() => pendingQb),
      set: jest.fn(() => pendingQb),
      where: jest.fn(() => pendingQb),
      andWhere: jest.fn(() => pendingQb),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    resendDeductPendingRepository = { createQueryBuilder: jest.fn(() => pendingQb) };

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
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: orderDeliveryRepository },
        { provide: getRepositoryToken(PartnerCompanyExternHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PartnerCompanyEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PinIssueDedupEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(SsgIssueLogEntity), useValue: ssgIssueLogRepository },
        { provide: getRepositoryToken(GiftielExchangeHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GalaxiaBarcodeLogEntity), useValue: makeRepoMock() },
        { provide: CryptoCipher, useValue: { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000') } },
        { provide: SsgInsertStateService, useValue: ssgInsertStateService },
        { provide: getRepositoryToken(SsgResendDeductPendingEntity), useValue: resendDeductPendingRepository },
      ],
    }).compile();

    sut = module.get(PartnerCompanyExternService);
  });

  it('후보 0건 → classifySsgPin 미호출(hot-path) + 새 PIN 발급', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([]);
    const classifySpy = jest.spyOn(sut as any, 'classifySsgPin');
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent());

    expect(classifySpy).not.toHaveBeenCalled();
    expect(ssgIssue.issue).toHaveBeenCalledTimes(1);
    expect(od.barCode).toBe('80000001');
  });

  it('후보 REGISTERED → 그 후보 PIN 재사용(새 INSERT 미발생)', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    jest.spyOn(sut as any, 'classifySsgPin').mockResolvedValue(SsgPinVerdict.REGISTERED);
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent());

    expect(ssgIssue.issue).not.toHaveBeenCalled();
    expect(od.barCode).toBe('8EXIST01');
    expect(od.personalCode).toBe('01300001234');
    // 행사 귀속(ssgEventId)을 메모리 반영 + markConfirmed 의 REQUIRES_NEW(PIN 과 동일 tx)로 durable 복원.
    // outer REQUIRED tx 에서 order_delivery 를 직접 update 하지 않는다(markConfirmed 와 self-deadlock 방지).
    expect(od.ssgEventId).toBe(42);
    expect(ssgInsertStateService.markConfirmed).toHaveBeenCalledWith(9001, expect.objectContaining({ ssgEventId: 42 }));
  });

  it('HIGH crash 안전: resendDeductionId 전달 + REGISTERED 후보 재사용 → pending 을 durable REUSED 마킹', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    jest.spyOn(sut as any, 'classifySsgPin').mockResolvedValue(SsgPinVerdict.REGISTERED);
    const od = buildOrderDelivery();

    const result = await sut.issue(od, buildSsgEvent(), 'rd-batch-1');

    expect(ssgIssue.issue).not.toHaveBeenCalled();
    expect(result.ssgNewIssue).toBe(false);
    // 재사용 시점에 pending(C) 을 'REUSED' 로 즉시(REQUIRES_NEW) durable 마킹 → sweep 이 state 무관하게 REVERSED.
    expect(pendingQb.set).toHaveBeenCalledWith({ issueOutcome: 'REUSED' });
    expect(pendingQb.where).toHaveBeenCalledWith('resend_deduction_id = :rid', { rid: 'rd-batch-1' });
  });

  it('resendDeductionId 미전달(비-배치 경로) → REGISTERED 재사용해도 pending 마킹 없음', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    jest.spyOn(sut as any, 'classifySsgPin').mockResolvedValue(SsgPinVerdict.REGISTERED);
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent());

    expect(pendingQb.set).not.toHaveBeenCalled();
  });

  it('후보 REGISTRATION_FAILED 전부 → 새 PIN (등록실패 PIN 재사용 금지)', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    jest.spyOn(sut as any, 'classifySsgPin').mockResolvedValue(SsgPinVerdict.REGISTRATION_FAILED);
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent());

    expect(ssgIssue.issue).toHaveBeenCalledTimes(1);
    expect(od.barCode).toBe('80000001');
  });

  it('후보 NOT_SUBMITTED 전부 → 새 PIN', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    jest.spyOn(sut as any, 'classifySsgPin').mockResolvedValue(SsgPinVerdict.NOT_SUBMITTED);
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent());

    expect(ssgIssue.issue).toHaveBeenCalledTimes(1);
    expect(od.barCode).toBe('80000001');
  });

  it('후보 PROCESSING(REGISTERED 없음) → 보류(SsgProcessingError, 새 INSERT 미발생)', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    jest.spyOn(sut as any, 'classifySsgPin').mockResolvedValue(SsgPinVerdict.PROCESSING);
    const od = buildOrderDelivery();

    await expect(sut.issue(od, buildSsgEvent())).rejects.toBeInstanceOf(SsgProcessingError);
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });

  it('classify 네트워크 오류(REGISTERED 없음) → 보류(SsgProcessingError)', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    jest.spyOn(sut as any, 'classifySsgPin').mockRejectedValue(new Error('network'));
    const od = buildOrderDelivery();

    await expect(sut.issue(od, buildSsgEvent())).rejects.toBeInstanceOf(SsgProcessingError);
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });

  it('다중후보: 최신 REGISTRATION_FAILED + 직전 REGISTERED → REGISTERED 후보 재사용', async () => {
    const newer = buildCandidate({ id: 2, barCode: '8NEWFAIL', personalCode: '01300000002' });
    const older = buildCandidate({ id: 1, barCode: '8OLDOK', personalCode: '01300000001' });
    ssgIssueLogRepository.find.mockResolvedValue([newer, older]); // id DESC
    jest
      .spyOn(sut as any, 'classifySsgPin')
      .mockResolvedValueOnce(SsgPinVerdict.REGISTRATION_FAILED)
      .mockResolvedValueOnce(SsgPinVerdict.REGISTERED);
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent());

    expect(ssgIssue.issue).not.toHaveBeenCalled();
    expect(od.barCode).toBe('8OLDOK');
    expect(od.personalCode).toBe('01300000001');
  });

  it('복수 REGISTERED → 최신 후보 재사용 + 잠재 이중등록 운영 알림', async () => {
    const newer = buildCandidate({ id: 2, barCode: '8NEWOK', personalCode: '01300000002' });
    const older = buildCandidate({ id: 1, barCode: '8OLDOK', personalCode: '01300000001' });
    ssgIssueLogRepository.find.mockResolvedValue([newer, older]); // id DESC
    jest.spyOn(sut as any, 'classifySsgPin').mockResolvedValue(SsgPinVerdict.REGISTERED);
    const errSpy = jest.spyOn((sut as any).logger, 'error');
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent());

    expect(ssgIssue.issue).not.toHaveBeenCalled();
    expect(od.barCode).toBe('8NEWOK'); // 최신 채택
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('다중 등록 PIN 감지'));
  });

  it('eventSeq=null legacy 후보 + getTry=Y(제출이력) → 보류(SsgProcessingError, classifySsgPin 미호출)', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate({ eventSeq: null })]);
    ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
    const classifySpy = jest.spyOn(sut as any, 'classifySsgPin');
    const od = buildOrderDelivery();

    await expect(sut.issue(od, buildSsgEvent())).rejects.toBeInstanceOf(SsgProcessingError);
    expect(classifySpy).not.toHaveBeenCalled();
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });

  it('eventSeq=null legacy 후보 + getTry=N(미제출) → 새 PIN', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate({ eventSeq: null })]);
    ssgIssue.getTry.mockResolvedValue(tryOut('N'));
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent());

    expect(ssgIssue.issue).toHaveBeenCalledTimes(1);
    expect(od.barCode).toBe('80000001');
  });
});
