import { Test, TestingModule } from '@nestjs/testing';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgOrphanResolveOutcome } from '../../partner_company_extern/interface/ssg.orphan.resolve';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { SsgInsertState } from '../interface/ssg.insert.state';
import { SsgRefundOutcome } from '../interface/ssg.refund.resolve';
import { RefundLedgerService } from './refund-ledger.service';
import { SsgInsertStateService } from './ssg-insert-state.service';
import { SsgRefundResolverService } from './ssg-refund.resolver';

/**
 * SsgRefundResolverService 단위 테스트
 * plans/ssg-balance-refactor.md PR3.A + PR3 보강.
 *
 * 검증 범위:
 *  - state NONE/FAILED → refundForDeliveryFail 호출 + markSsgSettled + RESTORED
 *  - state CONFIRMED → markSsgSettled + SKIPPED_CONFIRMED
 *  - state ATTEMPTED → orphan resolver 호출 후 outcome 분기
 *     CONFIRMED        → markSsgSettled + SKIPPED_CONFIRMED
 *     FAILED           → refundForDeliveryFail + markSsgSettled + RESTORED
 *     NETWORK_UNKNOWN  → DEFERRED (refund 안 부름, markSsgSettled 안 부름)
 *     SKIPPED_*        → DEFERRED (markSsgSettled 안 부름)
 *  - refundForDeliveryFail throw → 흡수 + DEFERRED, markSsgSettled 안 부름
 *  - resolver 자체 (getState/orphan) throw → 흡수 + DEFERRED
 */
describe('SsgRefundResolverService', () => {
  let sut: SsgRefundResolverService;
  let stateService: { getState: jest.Mock };
  let partnerExternService: { resolveSsgOrphan: jest.Mock };
  let ssgEventService: { refundForDeliveryFail: jest.Mock };
  let refundLedgerService: { markSsgSettled: jest.Mock };

  const baseInput = {
    orderDeliveryId: 99,
    ssgEventId: 36,
    refundAmount: 10_000,
    orderId: 4145,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    stateService = { getState: jest.fn() };
    partnerExternService = { resolveSsgOrphan: jest.fn() };
    ssgEventService = { refundForDeliveryFail: jest.fn().mockResolvedValue(undefined) };
    refundLedgerService = { markSsgSettled: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SsgRefundResolverService,
        { provide: SsgInsertStateService, useValue: stateService },
        { provide: PartnerCompanyExternService, useValue: partnerExternService },
        { provide: SsgEventService, useValue: ssgEventService },
        { provide: RefundLedgerService, useValue: refundLedgerService },
      ],
    }).compile();

    sut = module.get(SsgRefundResolverService);
  });

  it('state NONE → refundForDeliveryFail + markSsgSettled + RESTORED', async () => {
    stateService.getState.mockResolvedValue(SsgInsertState.NONE);

    const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

    expect(outcome).toBe(SsgRefundOutcome.RESTORED);
    expect(ssgEventService.refundForDeliveryFail).toHaveBeenCalledWith(
      baseInput.ssgEventId,
      baseInput.orderId,
      baseInput.refundAmount,
    );
    expect(refundLedgerService.markSsgSettled).toHaveBeenCalledWith(baseInput.orderDeliveryId);
    expect(partnerExternService.resolveSsgOrphan).not.toHaveBeenCalled();
  });

  it('state FAILED → refundForDeliveryFail + markSsgSettled + RESTORED', async () => {
    stateService.getState.mockResolvedValue(SsgInsertState.FAILED);

    const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

    expect(outcome).toBe(SsgRefundOutcome.RESTORED);
    expect(ssgEventService.refundForDeliveryFail).toHaveBeenCalled();
    expect(refundLedgerService.markSsgSettled).toHaveBeenCalledWith(baseInput.orderDeliveryId);
  });

  it('state CONFIRMED → markSsgSettled + SKIPPED_CONFIRMED, refund 안 부름', async () => {
    stateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);

    const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

    expect(outcome).toBe(SsgRefundOutcome.SKIPPED_CONFIRMED);
    expect(ssgEventService.refundForDeliveryFail).not.toHaveBeenCalled();
    expect(refundLedgerService.markSsgSettled).toHaveBeenCalledWith(baseInput.orderDeliveryId);
    expect(partnerExternService.resolveSsgOrphan).not.toHaveBeenCalled();
  });

  describe('state ATTEMPTED → orphan resolver 호출', () => {
    beforeEach(() => {
      stateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
    });

    it('orphan CONFIRMED → markSsgSettled + SKIPPED_CONFIRMED', async () => {
      partnerExternService.resolveSsgOrphan.mockResolvedValue(SsgOrphanResolveOutcome.CONFIRMED);

      const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.SKIPPED_CONFIRMED);
      expect(partnerExternService.resolveSsgOrphan).toHaveBeenCalledWith(baseInput.orderDeliveryId);
      expect(refundLedgerService.markSsgSettled).toHaveBeenCalledWith(baseInput.orderDeliveryId);
      expect(ssgEventService.refundForDeliveryFail).not.toHaveBeenCalled();
    });

    it('orphan FAILED → refundForDeliveryFail + markSsgSettled + RESTORED', async () => {
      partnerExternService.resolveSsgOrphan.mockResolvedValue(SsgOrphanResolveOutcome.FAILED);

      const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.RESTORED);
      expect(ssgEventService.refundForDeliveryFail).toHaveBeenCalled();
      expect(refundLedgerService.markSsgSettled).toHaveBeenCalledWith(baseInput.orderDeliveryId);
    });

    it('orphan NETWORK_UNKNOWN → DEFERRED, markSsgSettled 안 부름 (ledger 신호로 가드 차단)', async () => {
      partnerExternService.resolveSsgOrphan.mockResolvedValue(SsgOrphanResolveOutcome.NETWORK_UNKNOWN);

      const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.DEFERRED);
      expect(ssgEventService.refundForDeliveryFail).not.toHaveBeenCalled();
      expect(refundLedgerService.markSsgSettled).not.toHaveBeenCalled();
    });

    it('orphan SKIPPED_NO_CANDIDATES → DEFERRED, markSsgSettled 안 부름', async () => {
      partnerExternService.resolveSsgOrphan.mockResolvedValue(SsgOrphanResolveOutcome.SKIPPED_NO_CANDIDATES);

      const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.DEFERRED);
      expect(refundLedgerService.markSsgSettled).not.toHaveBeenCalled();
    });
  });

  describe('PR3 보강 — throw 흡수', () => {
    it('refundForDeliveryFail throw → 흡수 + DEFERRED, markSsgSettled 안 부름 (state NONE)', async () => {
      stateService.getState.mockResolvedValue(SsgInsertState.NONE);
      ssgEventService.refundForDeliveryFail.mockRejectedValue(new Error('SSG event balance not found'));

      const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.DEFERRED);
      expect(refundLedgerService.markSsgSettled).not.toHaveBeenCalled();
    });

    it('refundForDeliveryFail throw → 흡수 + DEFERRED (orphan FAILED 이후)', async () => {
      stateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
      partnerExternService.resolveSsgOrphan.mockResolvedValue(SsgOrphanResolveOutcome.FAILED);
      ssgEventService.refundForDeliveryFail.mockRejectedValue(new Error('SSG event balance not found'));

      const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.DEFERRED);
      expect(refundLedgerService.markSsgSettled).not.toHaveBeenCalled();
    });

    it('getState 자체 throw → 흡수 + DEFERRED', async () => {
      stateService.getState.mockRejectedValue(new Error('DB connection lost'));

      const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.DEFERRED);
      expect(ssgEventService.refundForDeliveryFail).not.toHaveBeenCalled();
      expect(refundLedgerService.markSsgSettled).not.toHaveBeenCalled();
    });

    it('resolveSsgOrphan 자체 throw → 흡수 + DEFERRED', async () => {
      stateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
      partnerExternService.resolveSsgOrphan.mockRejectedValue(new Error('network'));

      const outcome = await sut.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.DEFERRED);
      expect(refundLedgerService.markSsgSettled).not.toHaveBeenCalled();
    });
  });
});
