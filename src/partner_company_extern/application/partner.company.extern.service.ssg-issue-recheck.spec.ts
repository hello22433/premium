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
import { MarkAttemptedResult } from '../../delivery/interface/ssg.insert.state';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { SsgIssueUnknownError } from '../infra/ssg.issue';
import { PartnerCompanyExternService } from './partner.company.extern.service';

/**
 * issue() SSG 분기의 barCode-empty cust_info 후보 재조회 회귀 테스트.
 *
 * 후보가 있으면 계약상 입증된 단일 등록 PIN만 재사용한다. 미확정, legacy,
 * 복수 등록 후보는 새 PIN을 만들지 않고 안전하게 중단한다.
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
  let pinIssueCommandRepository: { findOne: jest.Mock };
  const activeAuthority = {
    commandId: 'command-1',
    ownerToken: 'owner-1',
    generation: '1',
    workflowVersion: '1',
  } as any;

  const tryOut = (tryYn: 'Y' | 'N') => ({
    response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ vno: ['x'], tryYn: [tryYn] }] },
  });
  const checkOut = (resultCd: string) => ({
    response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ resultCd: [resultCd] }] },
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
    pinIssueCommandRepository = {
      findOne: jest.fn().mockResolvedValue({ status: 'STARTED', externalIssueCount: 1 }),
    };
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
        { provide: getRepositoryToken(PinIssueCommandEntity), useValue: pinIssueCommandRepository },
        { provide: getRepositoryToken(GiftielExchangeHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GalaxiaBarcodeLogEntity), useValue: makeRepoMock() },
        { provide: CryptoCipher, useValue: { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000') } },
        { provide: SsgInsertStateService, useValue: ssgInsertStateService },
        { provide: getRepositoryToken(SsgResendDeductPendingEntity), useValue: resendDeductPendingRepository },
        { provide: PartnerSettleFeatureFlag, useValue: { isEnabled: false, isEnabledFor: () => false } },
        { provide: PartnerSettleProducerService, useValue: {} },
      ],
    }).compile();

    sut = module.get(PartnerCompanyExternService);
  });

  it('후보 0건 → classifySsgPin 미호출(hot-path) + 새 PIN 발급', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([]);
    const classifySpy = jest.spyOn(sut as any, 'classifySsgPin');
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent(), undefined, activeAuthority);

    expect(classifySpy).not.toHaveBeenCalled();
    expect(ssgIssue.issue).toHaveBeenCalledTimes(1);
    expect(od.barCode).toBe('80000001');
  });

  it('단일 CONFIRMED 후보 → 그 후보 PIN 재사용(새 INSERT 미발생)', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
    ssgIssue.check.mockResolvedValue(checkOut('0100'));
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent());

    expect(ssgIssue.issue).not.toHaveBeenCalled();
    expect(od.barCode).toBe('8EXIST01');
    expect(od.personalCode).toBe('01300001234');
    expect(od.ssgEventId).toBe(42);
    expect(ssgInsertStateService.markConfirmed).toHaveBeenCalledWith(9001, expect.objectContaining({ ssgEventId: 42 }));
  });

  it('HIGH crash 안전: resendDeductionId 전달 + 단일 CONFIRMED 후보 재사용 → pending 을 durable REUSED 마킹', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
    ssgIssue.check.mockResolvedValue(checkOut('0200'));
    const od = buildOrderDelivery();

    const result = await sut.issue(od, buildSsgEvent(), 'rd-batch-1');

    expect(ssgIssue.issue).not.toHaveBeenCalled();
    expect(result.ssgNewIssue).toBe(false);
    expect(pendingQb.set).toHaveBeenCalledWith({ issueOutcome: 'REUSED' });
    expect(pendingQb.where).toHaveBeenCalledWith('resend_deduction_id = :rid', { rid: 'rd-batch-1' });
  });

  it('resendDeductionId 미전달(비-배치 경로) + 단일 CONFIRMED 재사용 → pending 마킹 없음', async () => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
    ssgIssue.check.mockResolvedValue(checkOut('0400'));
    const od = buildOrderDelivery();

    await sut.issue(od, buildSsgEvent());

    expect(pendingQb.set).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ['resultCd=0103', () => {
      ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
      ssgIssue.check.mockResolvedValue(checkOut('0103'));
    }],
    ['getTry=N', () => {
      ssgIssue.getTry.mockResolvedValue(tryOut('N'));
    }],
  ])('후보 %s → SsgIssueUnknownError로 중단, 새 PIN INSERT 없음', async (_label, mockCandidate) => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    mockCandidate();
    const od = buildOrderDelivery();

    await expect(sut.issue(od, buildSsgEvent())).rejects.toBeInstanceOf(SsgIssueUnknownError);

    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ['PROCESSING', () => jest.spyOn(sut as any, 'classifySsgPin').mockResolvedValue('PROCESSING')],
    ['getTry 네트워크 오류', () => ssgIssue.getTry.mockRejectedValue(new Error('network'))],
  ])('후보 %s → SsgIssueUnknownError로 중단, 새 INSERT 미발생', async (_label, mockCandidate) => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
    mockCandidate();
    const od = buildOrderDelivery();

    await expect(sut.issue(od, buildSsgEvent())).rejects.toBeInstanceOf(SsgIssueUnknownError);
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });

  it('다중후보: 등록 확정 후보와 미확정 후보가 공존 → SsgIssueUnknownError, PIN 선택 없음', async () => {
    const newer = buildCandidate({ id: 2, barCode: '8NEWFAIL', personalCode: '01300000002' });
    const older = buildCandidate({ id: 1, barCode: '8OLDOK', personalCode: '01300000001' });
    ssgIssueLogRepository.find.mockResolvedValue([newer, older]);
    ssgIssue.getTry
      .mockResolvedValueOnce(tryOut('Y'))
      .mockResolvedValueOnce(tryOut('Y'));
    ssgIssue.check
      .mockResolvedValueOnce(checkOut('0103'))
      .mockResolvedValueOnce(checkOut('0100'));
    const od = buildOrderDelivery();

    await expect(sut.issue(od, buildSsgEvent())).rejects.toBeInstanceOf(SsgIssueUnknownError);

    expect(ssgIssue.issue).not.toHaveBeenCalled();
    expect(od.barCode).toBeNull();
  });

  it('복수 CONFIRMED → SsgIssueUnknownError, 최신 후보를 선택하지 않음', async () => {
    const newer = buildCandidate({ id: 2, barCode: '8NEWOK', personalCode: '01300000002' });
    const older = buildCandidate({ id: 1, barCode: '8OLDOK', personalCode: '01300000001' });
    ssgIssueLogRepository.find.mockResolvedValue([newer, older]);
    ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
    ssgIssue.check.mockResolvedValue(checkOut('0100'));
    const od = buildOrderDelivery();

    await expect(sut.issue(od, buildSsgEvent())).rejects.toBeInstanceOf(SsgIssueUnknownError);

    expect(ssgIssue.issue).not.toHaveBeenCalled();
    expect(od.barCode).toBeNull();
  });

  it.each<[string, () => void]>([
    ['getTry=Y', () => ssgIssue.getTry.mockResolvedValue(tryOut('Y'))],
    ['getTry=N', () => ssgIssue.getTry.mockResolvedValue(tryOut('N'))],
  ])('eventSeq=null legacy 후보 + %s → SsgIssueUnknownError로 중단, 새 PIN INSERT 없음', async (_label, mockCandidate) => {
    ssgIssueLogRepository.find.mockResolvedValue([buildCandidate({ eventSeq: null })]);
    mockCandidate();
    const classifySpy = jest.spyOn(sut as any, 'classifySsgPin');
    const od = buildOrderDelivery();

    await expect(sut.issue(od, buildSsgEvent())).rejects.toBeInstanceOf(SsgIssueUnknownError);

    expect(classifySpy).not.toHaveBeenCalled();
    expect(ssgIssue.issue).not.toHaveBeenCalled();
  });
});
