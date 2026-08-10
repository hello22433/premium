import {
  isCandidateLedger,
  hasPricingChanged,
  buildReversalGraph,
  graphLedgerIds,
  classifyGraph,
  computeDirectRecalc,
  computeProposalSeeds,
  computeGraphTargets,
  buildResolutionGroupKey,
  verifyGroupCompleteness,
  computeIncrementalAmount,
  ReversalGraphError,
  PricingResult,
} from './discount.reprice';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';

function makeLedger(overrides: Partial<PartnerSettleLedgerEntity> & { id: number }): PartnerSettleLedgerEntity {
  return {
    partnerCompanyId: 1,
    subItemKey: 'NONE',
    sourceType: 'ISSUANCE',
    orderDeliveryId: 100,
    galaxiaBarcodeLogId: null,
    occurredAt: new Date('2026-08-01'),
    baseAmount: '10000',
    discountAmount: '0',
    receivingCommissionAmount: '0',
    givingCommissionAmount: '500',
    vatAmount: '0',
    feeTotalAmount: '500',
    settleAmount: '9500',
    vatCalculationMode: 'NONE',
    appliedPricePercent: '5',
    appliedPriceAdjustment: IPriceAdjustment.DISCOUNT,
    appliedDiscountHistoryId: 10,
    pricingResolution: 'HISTORY_MATCH',
    idempotencyKey: `ISS:${overrides.id}`,
    settleBatchId: null,
    status: 'NORMAL',
    reviewCode: null,
    reviewResolution: null,
    resolvedBy: null,
    resolvedAt: null,
    providerEvidenceRef: null,
    providerEvidenceHash: null,
    memo: null,
    reversesLedgerId: null,
    transitionObservationId: null,
    transitionSequenceNo: null,
    transitionAllocationNo: null,
    sourceEventIdOrigin: null,
    reviewResolutionId: null,
    manualLedgerProposalId: null,
    orphanInboxRowId: null,
    paymentVarianceProposalId: null,
    adjustmentProposalId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PartnerSettleLedgerEntity;
}

const PRICING_5_DISCOUNT: PricingResult = {
  pricePercent: '5',
  priceAdjustment: IPriceAdjustment.DISCOUNT,
  appliedDiscountHistoryId: 10,
  pricingResolution: 'HISTORY_MATCH',
};

const PRICING_3_DISCOUNT: PricingResult = {
  pricePercent: '3',
  priceAdjustment: IPriceAdjustment.DISCOUNT,
  appliedDiscountHistoryId: 20,
  pricingResolution: 'HISTORY_MATCH',
};

describe('discount.reprice', () => {
  describe('isCandidateLedger', () => {
    const effectiveAt = new Date('2026-07-01');

    it('정상 candidate', () => {
      const l = makeLedger({ id: 1, occurredAt: new Date('2026-08-01') });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(true);
    });

    it('다른 협력사 제외', () => {
      const l = makeLedger({ id: 1, partnerCompanyId: 2 });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(false);
    });

    it('effectiveAt 이전 제외', () => {
      const l = makeLedger({ id: 1, occurredAt: new Date('2026-06-30') });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(false);
    });

    it('ADJUSTMENT 제외', () => {
      const l = makeLedger({ id: 1, sourceType: 'ADJUSTMENT' });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(false);
    });

    it('reversal child 제외', () => {
      const l = makeLedger({ id: 2, reversesLedgerId: 1 });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(false);
    });

    it('NEEDS_REVIEW 제외', () => {
      const l = makeLedger({ id: 1, status: 'NEEDS_REVIEW' });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(false);
    });

    it('DIRECT_AMOUNT 제외', () => {
      const l = makeLedger({ id: 1, pricingResolution: 'DIRECT_AMOUNT' });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(false);
    });

    it('NO_MATCH 포함 (pre-config 소급)', () => {
      const l = makeLedger({ id: 1, pricingResolution: 'NO_MATCH' });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(true);
    });

    it('ON_HOLD 포함', () => {
      const l = makeLedger({ id: 1, status: 'ON_HOLD' });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(true);
    });

    it('occurredAt null 제외', () => {
      const l = makeLedger({ id: 1, occurredAt: null });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(false);
    });

    it('baseAmount null 제외', () => {
      const l = makeLedger({ id: 1, baseAmount: null });
      expect(isCandidateLedger(l, 1, effectiveAt)).toBe(false);
    });
  });

  describe('hasPricingChanged', () => {
    it('동일 pricing → false', () => {
      const l = makeLedger({ id: 1 });
      expect(hasPricingChanged(l, PRICING_5_DISCOUNT)).toBe(false);
    });
    it('DECIMAL(7,4) 문자열과 같은 가격 → false', () => {
      const l = makeLedger({ id: 1, appliedPricePercent: '5.0000' });
      expect(hasPricingChanged(l, PRICING_5_DISCOUNT)).toBe(false);
    });

    it('percent 변경 → true', () => {
      const l = makeLedger({ id: 1 });
      expect(hasPricingChanged(l, PRICING_3_DISCOUNT)).toBe(true);
    });
  });

  describe('buildReversalGraph', () => {
    it('root만 — descendants 0', () => {
      const root = makeLedger({ id: 1 });
      expect(buildReversalGraph(root, [])).toEqual([]);
    });

    it('root + 직접 reversal', () => {
      const root = makeLedger({ id: 1 });
      const rev = makeLedger({ id: 2, reversesLedgerId: 1, baseAmount: '-10000' });
      const result = buildReversalGraph(root, [rev]);
      expect(result.map((r) => r.id)).toEqual([2]);
    });

    it('root + 직접 + 간접 reversal', () => {
      const root = makeLedger({ id: 1 });
      const rev1 = makeLedger({ id: 2, reversesLedgerId: 1 });
      const rev2 = makeLedger({ id: 3, reversesLedgerId: 2 });
      const result = buildReversalGraph(root, [rev1, rev2]);
      expect(result.map((r) => r.id).sort()).toEqual([2, 3]);
    });

    it('cycle → 에러', () => {
      const root = makeLedger({ id: 1, reversesLedgerId: null });
      const cycleChild = makeLedger({ id: 1, reversesLedgerId: 1 });
      expect(() => buildReversalGraph(root, [cycleChild])).toThrow(ReversalGraphError);
    });

    it('cross-partner → 에러', () => {
      const root = makeLedger({ id: 1, partnerCompanyId: 1 });
      const cross = makeLedger({ id: 2, reversesLedgerId: 1, partnerCompanyId: 2 });
      expect(() => buildReversalGraph(root, [cross])).toThrow(ReversalGraphError);
    });
  });

  describe('graphLedgerIds', () => {
    it('root + descendants → 정렬된 id 배열', () => {
      const root = makeLedger({ id: 5 });
      const d1 = makeLedger({ id: 2 });
      const d2 = makeLedger({ id: 8 });
      expect(graphLedgerIds(root, [d1, d2])).toEqual([2, 5, 8]);
    });
  });

  describe('classifyGraph', () => {
    it('unsettled + no batch release → DIRECT', () => {
      const ledgers = [makeLedger({ id: 1 }), makeLedger({ id: 2 })];
      expect(classifyGraph(ledgers, new Set())).toBe('DIRECT');
    });

    it('settleBatchId 있으면 → PROPOSAL', () => {
      const ledgers = [makeLedger({ id: 1 }), makeLedger({ id: 2, settleBatchId: 10 })];
      expect(classifyGraph(ledgers, new Set())).toBe('PROPOSAL');
    });

    it('batch release 이력 있으면 → PROPOSAL', () => {
      const ledgers = [makeLedger({ id: 1 }), makeLedger({ id: 2 })];
      expect(classifyGraph(ledgers, new Set([1]))).toBe('PROPOSAL');
    });
  });

  describe('computeDirectRecalc', () => {
    it('root 단독 재계산', () => {
      const root = makeLedger({ id: 1, baseAmount: '10000', settleAmount: '9500' });
      const results = computeDirectRecalc(root, PRICING_3_DISCOUNT, [], []);
      expect(results).toHaveLength(1);
      expect(results[0].ledgerId).toBe(1);
      expect(results[0].updates.appliedPricePercent).toBe('3');
      expect(results[0].updates.settleAmount).toBe('9700');
    });

    it('root + 전액취소 reversal 재계산', () => {
      const root = makeLedger({ id: 1, baseAmount: '10000', settleAmount: '9500' });
      const rev = makeLedger({ id: 2, reversesLedgerId: 1, baseAmount: '-10000', settleAmount: '-9500' });
      const results = computeDirectRecalc(root, PRICING_3_DISCOUNT, [rev], [rev]);
      expect(results).toHaveLength(2);
      expect(results[0].updates.settleAmount).toBe('9700');
      expect(results[1].updates.settleAmount).toBe('-9700');
    });

    it('간접 reversal (root → rev1 → rev2) 은 부모 기준으로 계산', () => {
      const root = makeLedger({ id: 1, baseAmount: '10000', settleAmount: '9500' });
      const rev1 = makeLedger({ id: 2, reversesLedgerId: 1, baseAmount: '-10000', settleAmount: '-9500' });
      const rev2 = makeLedger({ id: 3, reversesLedgerId: 2, baseAmount: '10000', settleAmount: '9500' });
      const all = [rev1, rev2];
      const results = computeDirectRecalc(root, PRICING_3_DISCOUNT, all, all);
      expect(results).toHaveLength(3);
      expect(results[0].updates.settleAmount).toBe('9700');
      expect(results[1].updates.settleAmount).toBe('-9700');
      expect(results[2].updates.settleAmount).toBe('9700');
    });
  });

  describe('computeProposalSeeds', () => {
    it('root 단독 — proposedAmount = target - current', () => {
      const root = makeLedger({ id: 1, baseAmount: '10000', settleAmount: '9500' });
      const seeds = computeProposalSeeds(root, PRICING_3_DISCOUNT, [], [], new Map());
      expect(seeds).toHaveLength(1);
      expect(seeds[0].sourceLedgerId).toBe(1);
      expect(seeds[0].proposedAmount).toBe(200n);
    });

    it('기존 approved sum 차감', () => {
      const root = makeLedger({ id: 1, baseAmount: '10000', settleAmount: '9500' });
      const sums = new Map([[1, 100n]]);
      const seeds = computeProposalSeeds(root, PRICING_3_DISCOUNT, [], [], sums);
      expect(seeds[0].proposedAmount).toBe(100n);
    });
  });

  describe('computeGraphTargets', () => {
    it('간접 reversal 도 부모 기준 target 반환', () => {
      const root = makeLedger({ id: 1, baseAmount: '10000', settleAmount: '9500' });
      const rev1 = makeLedger({ id: 2, reversesLedgerId: 1, baseAmount: '-10000', settleAmount: '-9500' });
      const rev2 = makeLedger({ id: 3, reversesLedgerId: 2, baseAmount: '10000', settleAmount: '9500' });
      const targets = computeGraphTargets(root, [rev1, rev2], PRICING_3_DISCOUNT);
      expect(targets.get(1)).toBe(9700n);
      expect(targets.get(2)).toBe(-9700n);
      expect(targets.get(3)).toBe(9700n);
    });
  });

  describe('buildResolutionGroupKey', () => {
    it('형식 = rootLedgerId:discountChangeId', () => {
      expect(buildResolutionGroupKey(42, 7)).toBe('42:7');
    });
  });

  describe('verifyGroupCompleteness', () => {
    it('동일 집합 → true', () => {
      expect(verifyGroupCompleteness([1, 2, 3], [3, 1, 2])).toBe(true);
    });

    it('누락 → false', () => {
      expect(verifyGroupCompleteness([1, 2, 3], [1, 2])).toBe(false);
    });

    it('초과 → false', () => {
      expect(verifyGroupCompleteness([1, 2], [1, 2, 3])).toBe(false);
    });
  });

  describe('computeIncrementalAmount', () => {
    it('target - (current + prior)', () => {
      expect(computeIncrementalAmount(9700n, 9500n, 100n)).toBe(100n);
    });

    it('0원 결과', () => {
      expect(computeIncrementalAmount(9500n, 9500n, 0n)).toBe(0n);
    });

    it('음수 결과', () => {
      expect(computeIncrementalAmount(9000n, 9500n, 0n)).toBe(-500n);
    });
  });
});
