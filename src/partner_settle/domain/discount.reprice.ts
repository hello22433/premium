import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import {
  calculatePartialReversal,
  calculateSettleAmounts,
  reverseAmounts,
  SettleAmountBreakdown,
  sumBreakdowns,
} from './settle.amount';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IPartnerSettleVatCalculationMode } from '../interface/partner.settle.source.type';

/**
 * 소급 재계산 도메인 순수 함수 (PR3C §3–§4).
 *
 * DB 접근 없음 — 호출부(service)가 잠금·조회를 끝낸 뒤 순수 데이터를 넘긴다.
 */

// ─── Types ───

export type RepriceCandidate = {
  ledger: PartnerSettleLedgerEntity;
  descendants: PartnerSettleLedgerEntity[];
};

export type PricingResult = {
  pricePercent: string;
  priceAdjustment: IPriceAdjustment;
  appliedDiscountHistoryId: number | null;
  pricingResolution: 'HISTORY_MATCH' | 'NO_MATCH';
};

export type RepriceClassification = 'DIRECT' | 'PROPOSAL';

export type RepriceDirectResult = {
  ledgerId: number;
  updates: LedgerAmountUpdate;
};

export type LedgerAmountUpdate = {
  appliedPricePercent: string;
  appliedPriceAdjustment: IPriceAdjustment;
  appliedDiscountHistoryId: number | null;
  pricingResolution: 'HISTORY_MATCH' | 'NO_MATCH';
  settleAmount: string;
  baseAmount: string;
  discountAmount: string;
  givingCommissionAmount: string;
  receivingCommissionAmount: string;
  vatAmount: string;
  feeTotalAmount: string;
};

export type ProposalSeed = {
  sourceLedgerId: number;
  proposedAmount: bigint;
  targetSettleAmount: bigint;
  reason: string;
};

// ─── Candidate filtering (§3.2) ───

export function isCandidateLedger(
  ledger: PartnerSettleLedgerEntity,
  partnerCompanyId: number,
  effectiveAt: Date,
): boolean {
  if (ledger.partnerCompanyId !== partnerCompanyId) return false;
  if (ledger.occurredAt === null || ledger.baseAmount === null) return false;
  if (ledger.occurredAt < effectiveAt) return false;
  if (ledger.sourceType === 'ADJUSTMENT') return false;
  if (ledger.reversesLedgerId !== null) return false;
  if (ledger.status !== 'NORMAL' && ledger.status !== 'ON_HOLD') return false;
  if (ledger.pricingResolution === 'DIRECT_AMOUNT') return false;
  if (ledger.pricingResolution !== 'HISTORY_MATCH' && ledger.pricingResolution !== 'NO_MATCH') return false;
  return true;
}

function normalizePricePercent(value: string | null): string {
  if (value === null) return '';
  const [integerPart, fractionalPart = ''] = value.split('.');
  const integer = integerPart.replace(/^(-?)0+(?=\d)/, '$1');
  const fractional = fractionalPart.replace(/0+$/, '');
  return fractional ? `${integer}.${fractional}` : integer;
}

export function hasPricingChanged(
  ledger: PartnerSettleLedgerEntity,
  newPricing: PricingResult,
): boolean {
  return (
    normalizePricePercent(ledger.appliedPricePercent) !== normalizePricePercent(newPricing.pricePercent) ||
    ledger.appliedPriceAdjustment !== newPricing.priceAdjustment ||
    ledger.appliedDiscountHistoryId !== newPricing.appliedDiscountHistoryId
  );
}

// ─── Reversal graph (§3.3) ───

export class ReversalGraphError extends Error {}

export function buildReversalGraph(
  root: PartnerSettleLedgerEntity,
  allLedgers: PartnerSettleLedgerEntity[],
): PartnerSettleLedgerEntity[] {
  const byReversesId = new Map<number, PartnerSettleLedgerEntity[]>();
  for (const l of allLedgers) {
    if (l.reversesLedgerId !== null) {
      const arr = byReversesId.get(l.reversesLedgerId) ?? [];
      arr.push(l);
      byReversesId.set(l.reversesLedgerId, arr);
    }
  }

  const descendants: PartnerSettleLedgerEntity[] = [];
  const visited = new Set<number>([root.id]);
  const stack = [root.id];

  while (stack.length > 0) {
    const parentId = stack.pop()!;
    const children = byReversesId.get(parentId) ?? [];
    for (const child of children) {
      if (visited.has(child.id)) {
        throw new ReversalGraphError(`cycle detected at ledger ${child.id}`);
      }
      if (child.partnerCompanyId !== root.partnerCompanyId) {
        throw new ReversalGraphError(
          `cross-partner reversal: root ${root.id} (partner ${root.partnerCompanyId}), child ${child.id} (partner ${child.partnerCompanyId})`,
        );
      }
      visited.add(child.id);
      descendants.push(child);
      stack.push(child.id);
    }
  }

  return descendants;
}

export function graphLedgerIds(root: PartnerSettleLedgerEntity, descendants: PartnerSettleLedgerEntity[]): number[] {
  const ids = [root.id, ...descendants.map((d) => d.id)];
  ids.sort((a, b) => a - b);
  return ids;
}

// ─── Classification (§3.4) ───

export function classifyGraph(
  graphLedgers: PartnerSettleLedgerEntity[],
  batchReleaseIds: Set<number>,
): RepriceClassification {
  for (const l of graphLedgers) {
    if (l.settleBatchId !== null) return 'PROPOSAL';
    if (batchReleaseIds.has(l.id)) return 'PROPOSAL';
  }
  return 'DIRECT';
}

// ─── Direct recalculation (§3.5) ───

export function computeDirectRecalc(
  root: PartnerSettleLedgerEntity,
  newPricing: PricingResult,
  descendants: PartnerSettleLedgerEntity[],
  existingReversals: PartnerSettleLedgerEntity[],
): RepriceDirectResult[] {
  const rootAmounts = calculateSettleAmounts({
    baseAmount: BigInt(root.baseAmount!),
    pricePercent: newPricing.pricePercent,
    priceAdjustment: newPricing.priceAdjustment,
    vatCalculationMode: root.vatCalculationMode,
    discountAmount: BigInt(root.discountAmount ?? '0'),
  });

  const results: RepriceDirectResult[] = [
    {
      ledgerId: root.id,
      updates: buildLedgerUpdate(rootAmounts, newPricing),
    },
  ];

  const ledgerMap = new Map<number, PartnerSettleLedgerEntity>();
  ledgerMap.set(root.id, root);
  for (const d of descendants) ledgerMap.set(d.id, d);

  const newAmountsById = new Map<number, SettleAmountBreakdown>();
  newAmountsById.set(root.id, rootAmounts);

  const sorted = [...descendants].sort((a, b) => a.id - b.id);

  for (const rev of sorted) {
    const sourceId = rev.reversesLedgerId!;
    const source = ledgerMap.get(sourceId)!;
    const sourceAmounts = newAmountsById.get(sourceId)!;

    const revAmounts = computeReversalAmounts(
      rev, source, sourceAmounts, newPricing, sorted, newAmountsById,
    );
    newAmountsById.set(rev.id, revAmounts);
    results.push({ ledgerId: rev.id, updates: buildLedgerUpdate(revAmounts, newPricing) });
  }

  return results;
}

// ─── Proposal seeds (§4.3–§4.4) ───

export function computeProposalSeeds(
  root: PartnerSettleLedgerEntity,
  newPricing: PricingResult,
  descendants: PartnerSettleLedgerEntity[],
  existingReversals: PartnerSettleLedgerEntity[],
  approvedAdjustmentSums: Map<number, bigint>,
): ProposalSeed[] {
  const targets = computeGraphTargets(root, descendants, newPricing);

  const seeds: ProposalSeed[] = [
    buildProposalSeed(root.id, targets.get(root.id)!, root.settleAmount, approvedAdjustmentSums),
  ];

  const sorted = [...descendants].sort((a, b) => a.id - b.id);
  for (const rev of sorted) {
    seeds.push(
      buildProposalSeed(rev.id, targets.get(rev.id)!, rev.settleAmount, approvedAdjustmentSums),
    );
  }

  return seeds;
}

export function computeGraphTargets(
  root: PartnerSettleLedgerEntity,
  descendants: PartnerSettleLedgerEntity[],
  pricing: PricingResult,
): Map<number, bigint> {
  const rootAmounts = calculateSettleAmounts({
    baseAmount: BigInt(root.baseAmount!),
    pricePercent: pricing.pricePercent,
    priceAdjustment: pricing.priceAdjustment,
    vatCalculationMode: root.vatCalculationMode,
    discountAmount: BigInt(root.discountAmount ?? '0'),
  });

  const targets = new Map<number, bigint>();
  targets.set(root.id, rootAmounts.settleAmount);

  const ledgerMap = new Map<number, PartnerSettleLedgerEntity>();
  ledgerMap.set(root.id, root);
  for (const d of descendants) ledgerMap.set(d.id, d);

  const breakdownById = new Map<number, SettleAmountBreakdown>();
  breakdownById.set(root.id, rootAmounts);

  const sorted = [...descendants].sort((a, b) => a.id - b.id);

  for (const rev of sorted) {
    const sourceId = rev.reversesLedgerId!;
    const source = ledgerMap.get(sourceId)!;
    const sourceAmounts = breakdownById.get(sourceId)!;

    const revAmounts = computeReversalAmounts(
      rev, source, sourceAmounts, pricing, sorted, breakdownById,
    );
    breakdownById.set(rev.id, revAmounts);
    targets.set(rev.id, revAmounts.settleAmount);
  }

  return targets;
}

function computeReversalAmounts(
  reversal: PartnerSettleLedgerEntity,
  source: PartnerSettleLedgerEntity,
  sourceAmounts: SettleAmountBreakdown,
  pricing: PricingResult,
  allDescendants: PartnerSettleLedgerEntity[],
  newAmountsById: Map<number, SettleAmountBreakdown>,
): SettleAmountBreakdown {
  const isFullReversal =
    BigInt(reversal.baseAmount ?? '0') === -BigInt(source.baseAmount ?? '0');

  if (isFullReversal) {
    return reverseAmounts(sourceAmounts);
  }

  const sourceId = reversal.reversesLedgerId!;
  const priorSiblings = allDescendants
    .filter((r) => r.reversesLedgerId === sourceId && r.id !== reversal.id && r.id < reversal.id);
  const priorBreakdowns = priorSiblings.map((s) => newAmountsById.get(s.id) ?? toBreakdown(s));
  const reversedTotals = sumBreakdowns(priorBreakdowns);

  return calculatePartialReversal({
    original: sourceAmounts,
    cancelBaseAmount: BigInt(reversal.baseAmount ?? '0') * -1n,
    reversedTotals,
    pricePercent: pricing.pricePercent,
    priceAdjustment: pricing.priceAdjustment,
    vatCalculationMode: source.vatCalculationMode,
  });
}

function buildProposalSeed(
  sourceLedgerId: number,
  targetSettleAmount: bigint,
  currentSettleAmount: string | null,
  approvedSums: Map<number, bigint>,
): ProposalSeed {
  const current = BigInt(currentSettleAmount ?? '0');
  const approvedSum = approvedSums.get(sourceLedgerId) ?? 0n;
  const proposedAmount = targetSettleAmount - (current + approvedSum);

  return {
    sourceLedgerId,
    proposedAmount,
    targetSettleAmount,
    reason: `소급 재계산 차액 (target=${targetSettleAmount}, current=${current}, priorAdj=${approvedSum})`,
  };
}

// ─── Resolution group key (§4.1) ───

export function buildResolutionGroupKey(rootLedgerId: number, discountChangeId: number): string {
  return `${rootLedgerId}:${discountChangeId}`;
}

// ─── Group completeness (§5.5 item 4) ───

export function verifyGroupCompleteness(
  graphNodeIds: number[],
  proposalSourceIds: number[],
): boolean {
  const graphSet = new Set(graphNodeIds);
  const proposalSet = new Set(proposalSourceIds);
  if (graphSet.size !== proposalSet.size) return false;
  for (const id of graphSet) {
    if (!proposalSet.has(id)) return false;
  }
  return true;
}

// ─── Incremental amount (§5.3 step 7, §4.4) ───

export function computeIncrementalAmount(
  targetSettleAmount: bigint,
  currentSettleAmount: bigint,
  approvedAdjustmentSum: bigint,
): bigint {
  return targetSettleAmount - (currentSettleAmount + approvedAdjustmentSum);
}

// ─── Helpers ───

function toBreakdown(ledger: PartnerSettleLedgerEntity): SettleAmountBreakdown {
  return {
    baseAmount: BigInt(ledger.baseAmount ?? '0'),
    discountAmount: BigInt(ledger.discountAmount ?? '0'),
    receivingCommissionAmount: BigInt(ledger.receivingCommissionAmount ?? '0'),
    givingCommissionAmount: BigInt(ledger.givingCommissionAmount ?? '0'),
    vatAmount: BigInt(ledger.vatAmount ?? '0'),
    feeTotalAmount: BigInt(ledger.feeTotalAmount ?? '0'),
    settleAmount: BigInt(ledger.settleAmount ?? '0'),
  };
}

function buildLedgerUpdate(amounts: SettleAmountBreakdown, pricing: PricingResult): LedgerAmountUpdate {
  return {
    appliedPricePercent: pricing.pricePercent,
    appliedPriceAdjustment: pricing.priceAdjustment,
    appliedDiscountHistoryId: pricing.appliedDiscountHistoryId,
    pricingResolution: pricing.pricingResolution,
    baseAmount: String(amounts.baseAmount),
    discountAmount: String(amounts.discountAmount),
    settleAmount: String(amounts.settleAmount),
    givingCommissionAmount: String(amounts.givingCommissionAmount),
    receivingCommissionAmount: String(amounts.receivingCommissionAmount),
    vatAmount: String(amounts.vatAmount),
    feeTotalAmount: String(amounts.feeTotalAmount),
  };
}
