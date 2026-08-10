import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerSettleAdjustmentProposalEntity } from '../../entity/partner.settle.adjustment.proposal.entity';
import { PartnerSettlePricingResolverService } from './partner.settle.pricing.resolver.service';
import { PartnerSettleAdjustmentProposalService } from './partner.settle.adjustment.proposal.service';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { PricingProductSnapshot } from '../domain/partner.settle.pricing';
import {
  isCandidateLedger,
  hasPricingChanged,
  buildReversalGraph,
  graphLedgerIds,
  classifyGraph,
  computeDirectRecalc,
  computeProposalSeeds,
  PricingResult,
} from '../domain/discount.reprice';

/**
 * 예약 발효 재계산 트리거 (PR3C §3).
 *
 * `applyReservation()` 트랜잭션 안에서 호출된다. lockPolicy 가 이미 잡혀 있으므로
 * 추가 정책 잠금은 불필요하다.
 */
@Injectable()
export class PartnerSettleRepriceService {
  private readonly logger = new Logger(PartnerSettleRepriceService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pricingResolver: PartnerSettlePricingResolverService,
    private readonly proposalService: PartnerSettleAdjustmentProposalService,
  ) {}

  async repriceForReservation(
    reservation: { partnerCompanyId: number; effectiveAt: Date },
    resultHistoryId: number,
    manager: EntityManager,
  ): Promise<{ directCount: number; proposalCount: number }> {

    const candidates = await this.findCandidates(reservation.partnerCompanyId, reservation.effectiveAt, manager);
    if (candidates.length === 0) {
      return { directCount: 0, proposalCount: 0 };
    }

    let directCount = 0;
    let proposalCount = 0;

    const allLedgers = await this.loadAllReversals(reservation.partnerCompanyId, manager);

    for (const candidate of candidates) {
      const newPricing = await this.resolvePricing(candidate, manager);
      if (!newPricing) continue;
      if (!hasPricingChanged(candidate, newPricing)) continue;

      const descendants = buildReversalGraph(candidate, allLedgers);
      const allGraphIds = graphLedgerIds(candidate, descendants);

      const graphLedgers = await manager
        .getRepository(PartnerSettleLedgerEntity)
        .createQueryBuilder('l')
        .setLock('pessimistic_write')
        .where('l.id IN (:...ids)', { ids: allGraphIds })
        .orderBy('l.id', 'ASC')
        .getMany();

      const batchReleaseIds = await this.loadBatchReleaseIds(allGraphIds, manager);
      const classification = classifyGraph(graphLedgers, batchReleaseIds);

      const lockedRoot = graphLedgers.find((l) => l.id === candidate.id)!;
      const lockedDescendants = graphLedgers.filter((l) => l.id !== candidate.id);

      if (classification === 'DIRECT') {
        const results = computeDirectRecalc(lockedRoot, newPricing, lockedDescendants, graphLedgers);
        for (const result of results) {
          await manager.getRepository(PartnerSettleLedgerEntity).update(result.ledgerId, result.updates);
        }
        directCount += results.length;
      } else {
        const approvedSums = await this.loadApprovedAdjustmentSums(allGraphIds, manager);
        const seeds = computeProposalSeeds(
          lockedRoot,
          newPricing,
          lockedDescendants,
          graphLedgers,
          approvedSums,
        );

        await this.proposalService.createRepriceProposals(
          {
            partnerCompanyId: reservation.partnerCompanyId,
            rootLedger: lockedRoot,
            descendants: lockedDescendants,
            discountChangeId: resultHistoryId,
            seeds,
          },
          manager,
        );
        proposalCount += seeds.length;
      }
    }

    this.logger.log(
      `reprice: partner=${reservation.partnerCompanyId} direct=${directCount} proposals=${proposalCount}`,
    );
    return { directCount, proposalCount };
  }

  private async findCandidates(
    partnerCompanyId: number,
    effectiveAt: Date,
    manager: EntityManager,
  ): Promise<PartnerSettleLedgerEntity[]> {
    const ledgers = await manager
      .getRepository(PartnerSettleLedgerEntity)
      .createQueryBuilder('l')
      .where('l.partnerCompanyId = :pcId', { pcId: partnerCompanyId })
      .andWhere('l.occurredAt >= :effectiveAt', { effectiveAt })
      .andWhere("l.sourceType != 'ADJUSTMENT'")
      .andWhere('l.reversesLedgerId IS NULL')
      .andWhere("l.status IN ('NORMAL', 'ON_HOLD')")
      .andWhere("l.pricingResolution IN ('HISTORY_MATCH', 'NO_MATCH')")
      .andWhere('l.occurredAt IS NOT NULL')
      .andWhere('l.baseAmount IS NOT NULL')
      .orderBy('l.id', 'ASC')
      .getMany();

    return ledgers.filter((l) => isCandidateLedger(l, partnerCompanyId, effectiveAt));
  }

  private async loadAllReversals(
    partnerCompanyId: number,
    manager: EntityManager,
  ): Promise<PartnerSettleLedgerEntity[]> {
    return manager
      .getRepository(PartnerSettleLedgerEntity)
      .createQueryBuilder('l')
      .where('l.partnerCompanyId = :pcId', { pcId: partnerCompanyId })
      .andWhere('l.reversesLedgerId IS NOT NULL')
      .orderBy('l.id', 'ASC')
      .getMany();
  }

  private async resolvePricing(
    ledger: PartnerSettleLedgerEntity,
    manager: EntityManager,
  ): Promise<PricingResult | null> {
    const snapshot = await this.loadSnapshot(ledger.orderDeliveryId, manager);

    const pricing = await this.pricingResolver.resolveAt(
      ledger.partnerCompanyId,
      ledger.occurredAt!,
      snapshot,
      manager,
    );

    if (pricing.status === 'NEEDS_REVIEW') {
      throw new Error(
        `reprice: resolveAt returned NEEDS_REVIEW for ledger ${ledger.id} — ` +
          'applyReservation 트랜잭션 전체가 롤백됩니다.',
      );
    }

    return {
      pricePercent: String(pricing.pricePercent),
      priceAdjustment: pricing.priceAdjustment,
      appliedDiscountHistoryId: pricing.appliedDiscountHistoryId,
      pricingResolution: pricing.pricingResolution as 'HISTORY_MATCH' | 'NO_MATCH',
    };
  }

  private async loadSnapshot(
    orderDeliveryId: number | null,
    manager: EntityManager,
  ): Promise<PricingProductSnapshot> {
    if (orderDeliveryId === null) {
      return { price: null, category: null, classificationId: null, brandNameKorean: null };
    }
    const opm = await manager
      .getRepository(OrderProductMappingEntity)
      .createQueryBuilder('opm')
      .where('opm.orderDeliveryId = :odId', { odId: orderDeliveryId })
      .getOne();
    if (!opm) {
      return { price: null, category: null, classificationId: null, brandNameKorean: null };
    }
    return {
      price: opm.snapshotProductPrice ?? null,
      category: opm.snapshotProductCategory ?? null,
      classificationId: opm.snapshotProductClassificationId ?? null,
      brandNameKorean: opm.snapshotProductBrandName ?? null,
    };
  }

  private async loadBatchReleaseIds(ledgerIds: number[], manager: EntityManager): Promise<Set<number>> {
    if (ledgerIds.length === 0) return new Set();

    const rows: { ledgerId: number }[] = await manager.query(
      `SELECT ledger_id AS ledgerId FROM partner_settle_batch_release WHERE ledger_id IN (${ledgerIds.map(() => '?').join(',')})`,
      ledgerIds,
    );
    return new Set(rows.map((r) => r.ledgerId));
  }

  private async loadApprovedAdjustmentSums(
    ledgerIds: number[],
    manager: EntityManager,
  ): Promise<Map<number, bigint>> {
    if (ledgerIds.length === 0) return new Map();

    const rows: { sourceLedgerId: number; total: string }[] = await manager.query(
      `SELECT source_ledger_id AS sourceLedgerId, COALESCE(SUM(CAST(approved_amount AS SIGNED)), 0) AS total
       FROM partner_settle_adjustment_proposal
       WHERE source_ledger_id IN (${ledgerIds.map(() => '?').join(',')})
         AND status = 'APPROVED'
       GROUP BY source_ledger_id`,
      ledgerIds,
    );

    const map = new Map<number, bigint>();
    for (const row of rows) {
      map.set(row.sourceLedgerId, BigInt(row.total));
    }
    return map;
  }
}
