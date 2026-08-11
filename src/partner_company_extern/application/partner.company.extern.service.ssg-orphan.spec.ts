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
import { SsgInsertState } from '../../delivery/interface/ssg.insert.state';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { SsgCheckNotFoundError } from '../infra/ssg.issue';
import { SsgOrphanResolveOutcome } from '../interface/ssg.orphan.resolve';
import { PartnerCompanyExternService } from './partner.company.extern.service';

/**
 * SSG orphan resolver 단위 테스트
 * plans/ssg-balance-refactor.md PR2.
 *
 * 검증 범위:
 *  1) state ≠ ATTEMPTED → SKIPPED_NOT_ATTEMPTED
 *  2) 후보 부재 → NETWORK_UNKNOWN (부재는 미발급 증명이 아님)
 *  3) 첫 candidate 등록 확인 → markConfirmed + CONFIRMED
 *  4) NOT_ISSUED 증명이 있을 때만 markFailed + FAILED
 *  5) check 네트워크 오류 → NETWORK_UNKNOWN (markFailed 안 부름)
 */
describe('PartnerCompanyExternService - SSG orphan resolver', () => {
  let sut: PartnerCompanyExternService;
  let ssgIssue: { check: jest.Mock; issue: jest.Mock; generateSsgIssue: jest.Mock; getTry: jest.Mock };
  let ssgIssueLogRepository: jest.Mocked<Repository<SsgIssueLogEntity>>;
  let ssgInsertStateService: {
    getState: jest.Mock;
    markAttempted: jest.Mock;
    markConfirmed: jest.Mock;
    markFailed: jest.Mock;
  };

  const buildLog = (overrides: Partial<SsgIssueLogEntity> = {}): SsgIssueLogEntity =>
    ({
      id: 1,
      barCode: '80000001',
      personalCode: '01312345678',
      orderDeliveryId: 99,
      ssgTransactionId: 'tr-1',
      eventNo: 'EV1',
      eventSeq: 1,
      ssgEventId: 42,
      insertedAt: new Date(),
      expireAt: new Date('2026-07-18T00:00:00Z'),
      encourageAt: new Date('2026-06-01T00:00:00Z'),
      couponNum: 'CN-1',
      ...overrides,
    }) as SsgIssueLogEntity;

  const makeRepoMock = () => ({
    find: jest.fn(),
    findOne: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    save: jest.fn(),
  });

  // GetSsgTry 응답(cust_info 제출여부) mock
  const tryOut = (tryYn: 'Y' | 'N') => ({
    response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ vno: ['x'], tryYn: [tryYn] }] },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    ssgIssue = {
      check: jest.fn(),
      issue: jest.fn(),
      generateSsgIssue: jest.fn(),
      // Default to submitted so a successful status lookup can prove a sendable PIN.
      getTry: jest.fn().mockResolvedValue(tryOut('Y')),
    };
    ssgIssueLogRepository = { ...mock<Repository<SsgIssueLogEntity>>(), ...makeRepoMock() } as unknown as jest.Mocked<
      Repository<SsgIssueLogEntity>
    >;
    ssgInsertStateService = {
      getState: jest.fn(),
      markAttempted: jest.fn(),
      // markConfirmed/markFailed 는 전이 성공 여부를 boolean으로 반환 (PR2 — orphan resolver outcome 정확화)
      markConfirmed: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(true),
    };

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
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PartnerCompanyExternHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PartnerCompanyEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PinIssueDedupEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(SsgIssueLogEntity), useValue: ssgIssueLogRepository },
        { provide: getRepositoryToken(PinIssueCommandEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GiftielExchangeHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GalaxiaBarcodeLogEntity), useValue: makeRepoMock() },
        { provide: CryptoCipher, useValue: { safeDecryptDeliveryTarget: jest.fn() } },
        { provide: SsgInsertStateService, useValue: ssgInsertStateService },
        { provide: getRepositoryToken(SsgResendDeductPendingEntity), useValue: {} },
        { provide: PartnerSettleFeatureFlag, useValue: { isEnabled: false, isEnabledFor: () => false } },
        { provide: PartnerSettleProducerService, useValue: {} },
      ],
    }).compile();

    sut = module.get(PartnerCompanyExternService);
  });

  it('state ≠ ATTEMPTED 이면 SKIPPED_NOT_ATTEMPTED 반환, 외부 호출 안 함', async () => {
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);

    const result = await sut.resolveSsgOrphan(99);

    expect(result).toBe(SsgOrphanResolveOutcome.SKIPPED_NOT_ATTEMPTED);
    expect(ssgIssue.check).not.toHaveBeenCalled();
    expect(ssgInsertStateService.markConfirmed).not.toHaveBeenCalled();
    expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
  });

  it('후보가 없으면 발급 부재가 증명되지 않았으므로 NETWORK_UNKNOWN으로 보류한다', async () => {
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
    ssgIssueLogRepository.find = jest.fn().mockResolvedValue([]);

    const result = await sut.resolveSsgOrphan(99);

    expect(result).toBe(SsgOrphanResolveOutcome.NETWORK_UNKNOWN);
    expect(ssgIssue.check).not.toHaveBeenCalled();
    expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
  });

  it('단일 CONFIRMED 후보라도 전체 후보를 조회한 뒤 markConfirmed 한다', async () => {
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
    const newer = buildLog({ id: 2, personalCode: '01300000002' });
    ssgIssueLogRepository.find = jest.fn().mockResolvedValue([newer]);
    ssgIssue.check.mockResolvedValue({
      response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ resultCd: ['0100'] }] },
    });

    const result = await sut.resolveSsgOrphan(99);

    expect(result).toBe(SsgOrphanResolveOutcome.CONFIRMED);
    expect(ssgIssue.check).toHaveBeenCalledTimes(1);
    expect(ssgIssue.check).toHaveBeenCalledWith({
      eventNo: newer.eventNo,
      eventSeq: newer.eventSeq,
      vno: newer.personalCode,
    });
    expect(ssgInsertStateService.markConfirmed).toHaveBeenCalledWith(99, {
      barCode: newer.barCode,
      personalCode: newer.personalCode,
      ssgTransactionId: newer.ssgTransactionId,
      couponNum: newer.couponNum,
      expireAt: newer.expireAt,
      encourageAt: newer.encourageAt,
      ssgEventId: newer.ssgEventId,
    });
    expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
  });

  it('미증빙 NotFound 응답만 있으면 UNKNOWN으로 보류하고 markFailed 하지 않는다', async () => {
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
    ssgIssueLogRepository.find = jest.fn().mockResolvedValue([buildLog({ id: 2 }), buildLog({ id: 1 })]);
    ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));

    const result = await sut.resolveSsgOrphan(99);

    expect(result).toBe(SsgOrphanResolveOutcome.NETWORK_UNKNOWN);
    expect(ssgIssue.check).toHaveBeenCalledTimes(6);
    expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
    expect(ssgInsertStateService.markConfirmed).not.toHaveBeenCalled();
  });

  it('result 미반영(NotFound)이지만 cust_info 제출 이력 있음(getTry=Y) → 처리중 → NETWORK_UNKNOWN, markFailed 안 부름', async () => {
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
    ssgIssueLogRepository.find = jest.fn().mockResolvedValue([buildLog()]);
    ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
    ssgIssue.getTry.mockResolvedValue(tryOut('Y'));

    const result = await sut.resolveSsgOrphan(99);

    expect(result).toBe(SsgOrphanResolveOutcome.NETWORK_UNKNOWN);
    expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
    expect(ssgInsertStateService.markConfirmed).not.toHaveBeenCalled();
  });

  it('check 네트워크 오류 → NETWORK_UNKNOWN, markFailed 안 부름', async () => {
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
    ssgIssueLogRepository.find = jest.fn().mockResolvedValue([buildLog()]);
    // checkSsgWithRetry 는 SsgCheckNotFoundError가 아닌 에러는 그대로 throw 한다
    ssgIssue.check.mockRejectedValue(new Error('socket hang up'));

    const result = await sut.resolveSsgOrphan(99);

    expect(result).toBe(SsgOrphanResolveOutcome.NETWORK_UNKNOWN);
    expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
    expect(ssgInsertStateService.markConfirmed).not.toHaveBeenCalled();
  });

  it('markConfirmed silent skip (race) → NETWORK_UNKNOWN', async () => {
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
    ssgIssueLogRepository.find = jest.fn().mockResolvedValue([buildLog()]);
    ssgIssue.check.mockResolvedValue({ response: { result: [{ code: ['1001'], reason: ['ok'] }] } });
    ssgInsertStateService.markConfirmed.mockResolvedValue(false);

    const result = await sut.resolveSsgOrphan(99);

    expect(result).toBe(SsgOrphanResolveOutcome.NETWORK_UNKNOWN);
  });

  it('markFailed silent skip (race) → NETWORK_UNKNOWN', async () => {
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
    ssgIssueLogRepository.find = jest.fn().mockResolvedValue([buildLog()]);
    ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
    ssgInsertStateService.markFailed.mockResolvedValue(false);

    const result = await sut.resolveSsgOrphan(99);

    expect(result).toBe(SsgOrphanResolveOutcome.NETWORK_UNKNOWN);
  });
});
