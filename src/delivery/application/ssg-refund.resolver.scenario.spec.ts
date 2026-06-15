// typeorm-transactional 데코레이터를 no-op으로 mock
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_t: unknown, _k: unknown, _d: unknown) => _d,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { SsgOrphanResolveOutcome } from '../../partner_company_extern/interface/ssg.orphan.resolve';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { SsgInsertState } from '../interface/ssg.insert.state';
import { SsgRefundOutcome } from '../interface/ssg.refund.resolve';
import { RefundLedgerService } from './refund-ledger.service';
import { SsgInsertStateService } from './ssg-insert-state.service';
import { SsgRefundResolverService } from './ssg-refund.resolver';

/**
 * SsgRefundResolverService 시나리오 spec (PR1~PR3 resolver 분기 시퀀스)
 * plans/ssg-balance-refactor.md PR5.
 *
 * **범위 한정** — 본 spec 은 `SsgRefundResolverService.resolveAndRefundIfNeeded` 의 분기 outcome 시나리오에
 * 집중한다. DeliveryBatchService 가드 (ledger.exists + state + ssg_balance_settled) 호출까지 묶는 진짜
 * end-to-end 통합은 `delivery.batch.refund-ledger-guard.spec.ts` 가 별도로 커버한다.
 *
 * 즉 본 spec 은:
 *  - resolver 외부 입력 (state, orphan outcome, refundForDeliveryFail throw) 시퀀스에 따른
 *  - resolver 출력 (RESTORED / SKIPPED_CONFIRMED / DEFERRED) + markSsgSettled 호출 여부 검증.
 *
 * 가드 통과/차단 자체 동작은 본 spec 에서 검증하지 않으며 주석 형태로만 후속 영향 언급.
 *
 * 관련 spec 분담:
 *   - resolver 단위:                          `ssg-refund.resolver.spec.ts`
 *   - 재발송 가드 (ledger + state + settled): `delivery.batch.refund-ledger-guard.spec.ts`
 *   - state machine helper:                    `ssg-insert-state.service.spec.ts`
 *   - orphan resolver:                         `partner.company.extern.service.ssg-orphan.spec.ts`
 *   - issue() flow + state 통합:               `partner.company.extern.service.ssg-issue.spec.ts`
 */
describe('SsgRefundResolverService — 시나리오 분기 (PR1~PR3)', () => {
  let resolver: SsgRefundResolverService;
  let stateService: { getState: jest.Mock };
  let partnerExternService: { resolveSsgOrphan: jest.Mock };
  let ssgEventService: { refundForDeliveryFail: jest.Mock };
  let refundLedgerService: { markSsgSettled: jest.Mock; isSsgSettled: jest.Mock; exists: jest.Mock };

  const baseInput = {
    orderDeliveryId: 4145,
    ssgEventId: 36,
    refundAmount: 10_000,
    orderId: 4145,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    stateService = { getState: jest.fn() };
    partnerExternService = { resolveSsgOrphan: jest.fn() };
    ssgEventService = { refundForDeliveryFail: jest.fn() };
    refundLedgerService = {
      markSsgSettled: jest.fn().mockResolvedValue(undefined),
      isSsgSettled: jest.fn(),
      exists: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SsgRefundResolverService,
        { provide: SsgInsertStateService, useValue: stateService },
        { provide: PartnerCompanyExternService, useValue: partnerExternService },
        { provide: SsgEventService, useValue: ssgEventService },
        { provide: RefundLedgerService, useValue: refundLedgerService },
      ],
    }).compile();

    resolver = module.get(SsgRefundResolverService);
  });

  describe('시나리오 1 — 발송 실패 (state=NONE) → refund 성공 → 재발송 정상 흐름', () => {
    it('resolver NONE → refundForDeliveryFail + markSsgSettled → 다음 가드 통과', async () => {
      // 1. refundForFail 호출 시점 state=NONE (SSG INSERT 시도 전 실패)
      stateService.getState.mockResolvedValue(SsgInsertState.NONE);
      ssgEventService.refundForDeliveryFail.mockResolvedValue(undefined);

      // resolver 호출
      const outcome = await resolver.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.RESTORED);
      expect(ssgEventService.refundForDeliveryFail).toHaveBeenCalledWith(36, 4145, 10_000, 4145, undefined);
      // ssg_balance_settled 가 true 로 마킹되어 다음 재발송 가드 통과
      expect(refundLedgerService.markSsgSettled).toHaveBeenCalledWith(4145, undefined);
    });
  });

  describe('시나리오 2 — refundForDeliveryFail throw → DEFERRED → 재발송 가드 차단', () => {
    it('SSG refund 실패 시 markSsgSettled 안 부름 → ssg_balance_settled=false 유지', async () => {
      stateService.getState.mockResolvedValue(SsgInsertState.NONE);
      ssgEventService.refundForDeliveryFail.mockRejectedValue(new Error('SSG event balance row not found'));

      const outcome = await resolver.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.DEFERRED);
      // markSsgSettled 호출 안 됨 → ledger.ssg_balance_settled=false 유지
      expect(refundLedgerService.markSsgSettled).not.toHaveBeenCalled();
      // 후속 재발송 가드는 ssg_balance_settled=false 보고 차단 (delivery.batch.refund-ledger-guard.spec 에서 검증)
    });
  });

  describe('시나리오 3 — CONFIRMED + SMS 실패 → SSG 잔액 안 건드림 + 고객 환불 진행', () => {
    it('resolver CONFIRMED → markSsgSettled + SKIPPED_CONFIRMED, refundForDeliveryFail 호출 안 함', async () => {
      // SSG INSERT 는 성공 (CONFIRMED), SMS 발송에서 실패 → refundForFail 호출
      stateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);

      const outcome = await resolver.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.SKIPPED_CONFIRMED);
      // SSG 행사 잔액 건드리지 않음 (gross 모델 정합)
      expect(ssgEventService.refundForDeliveryFail).not.toHaveBeenCalled();
      // ledger.ssg_balance_settled=true 마킹 → 가드 통과 (그러나 state=CONFIRMED 라 새 선차감 X)
      expect(refundLedgerService.markSsgSettled).toHaveBeenCalledWith(4145, undefined);
    });
  });

  describe('시나리오 4 — timeout (ATTEMPTED 유지) → orphan resolver 후 분기', () => {
    it('ATTEMPTED + orphan CONFIRMED → SSG 잔액 안 건드림', async () => {
      stateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
      partnerExternService.resolveSsgOrphan.mockResolvedValue(SsgOrphanResolveOutcome.CONFIRMED);

      const outcome = await resolver.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.SKIPPED_CONFIRMED);
      expect(partnerExternService.resolveSsgOrphan).toHaveBeenCalledWith(4145);
      expect(ssgEventService.refundForDeliveryFail).not.toHaveBeenCalled();
      expect(refundLedgerService.markSsgSettled).toHaveBeenCalledWith(4145, undefined);
    });

    it('ATTEMPTED + orphan FAILED → refundForDeliveryFail + RESTORED', async () => {
      stateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
      partnerExternService.resolveSsgOrphan.mockResolvedValue(SsgOrphanResolveOutcome.FAILED);
      ssgEventService.refundForDeliveryFail.mockResolvedValue(undefined);

      const outcome = await resolver.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.RESTORED);
      expect(ssgEventService.refundForDeliveryFail).toHaveBeenCalled();
      expect(refundLedgerService.markSsgSettled).toHaveBeenCalledWith(4145, undefined);
    });

    it('ATTEMPTED + orphan NETWORK_UNKNOWN → DEFERRED (잔액 안 건드림, 다음 시도 보류)', async () => {
      stateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
      partnerExternService.resolveSsgOrphan.mockResolvedValue(SsgOrphanResolveOutcome.NETWORK_UNKNOWN);

      const outcome = await resolver.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.DEFERRED);
      expect(ssgEventService.refundForDeliveryFail).not.toHaveBeenCalled();
      expect(refundLedgerService.markSsgSettled).not.toHaveBeenCalled();
    });
  });

  describe('시나리오 5 — resolver 자체 예외 흡수', () => {
    it('getState throw → DEFERRED, markSsgSettled 안 부름', async () => {
      stateService.getState.mockRejectedValue(new Error('DB connection timeout'));

      const outcome = await resolver.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.DEFERRED);
      expect(refundLedgerService.markSsgSettled).not.toHaveBeenCalled();
    });

    it('resolveSsgOrphan throw → DEFERRED', async () => {
      stateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
      partnerExternService.resolveSsgOrphan.mockRejectedValue(new Error('SSG check parse error'));

      const outcome = await resolver.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.DEFERRED);
      expect(refundLedgerService.markSsgSettled).not.toHaveBeenCalled();
    });
  });

  describe('시나리오 6 — FAILED state 도 복구 대상 (v4 채택 의도)', () => {
    it('state=FAILED 는 "복구 완료 증거" 아님 → refundForDeliveryFail 다시 호출', async () => {
      stateService.getState.mockResolvedValue(SsgInsertState.FAILED);
      ssgEventService.refundForDeliveryFail.mockResolvedValue(undefined);

      const outcome = await resolver.resolveAndRefundIfNeeded(baseInput);

      expect(outcome).toBe(SsgRefundOutcome.RESTORED);
      expect(ssgEventService.refundForDeliveryFail).toHaveBeenCalled();
      expect(refundLedgerService.markSsgSettled).toHaveBeenCalledWith(4145, undefined);
    });
  });
});
