import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerSettleReviewAuditEntity } from '../../entity/partner.settle.review.audit.entity';
import { PartnerSettlePricingResolverService } from './partner.settle.pricing.resolver.service';
import { calculateSettleAmounts } from '../domain/settle.amount';
import { PricingProductSnapshot } from '../domain/partner.settle.pricing';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { IPartnerSettleReviewCode } from '../interface/partner.settle.source.type';

const MAX_RECALC_BATCH = 200;

type RecalcResultItem = { ledgerId: number; status: 'NORMAL' } | { ledgerId: number; code: RecalcFailCode };

type RecalcFailCode = 'NOT_FOUND' | 'ALREADY_RESOLVED' | 'ON_HOLD' | 'NOT_DETERMINISTIC' | 'VALIDATION_FAILED';

/**
 * deterministic 재계산 (정본 §9 recalculate · §8.2 케이스 2b·3 해소).
 *
 * 대상: COVERAGE_GAP / POLICY_CONFLICT 만. 이력 변경(seed 보정) 후 호출하면
 * history 재구성 → 매입율 판정 → 금액 재계산 → NORMAL 전환.
 *
 * 시각/금액/UNKNOWN/DISCARD 등 사람 확정이 필요한 경우는 resolve propose→approve (§5.11).
 */
@Injectable()
export class PartnerSettleReviewRecalculateService {
  private readonly logger = new Logger(PartnerSettleReviewRecalculateService.name);

  constructor(
    @InjectRepository(PartnerSettleLedgerEntity)
    private readonly ledgerRepository: Repository<PartnerSettleLedgerEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private readonly opmRepository: Repository<OrderProductMappingEntity>,
    @InjectRepository(PartnerSettleReviewAuditEntity)
    private readonly auditRepository: Repository<PartnerSettleReviewAuditEntity>,
    private readonly pricingResolver: PartnerSettlePricingResolverService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 요청 ledgerIds 또는 (partnerCompanyId, subItemKey?) 대상으로 deterministic 재계산.
   * 각 ledger 독립 트랜잭션, 부분 성공 허용.
   */
  async recalculate(
    params: { ledgerIds: number[] } | { partnerCompanyId: number; subItemKey?: string },
    actorId: number,
  ): Promise<{ succeeded: RecalcResultItem[]; failed: RecalcResultItem[] }> {
    const ledgerIds = await this.resolveLedgerIds(params);

    if (ledgerIds.length > MAX_RECALC_BATCH) {
      throw new BadRequestException(
        `최대 ${MAX_RECALC_BATCH}건까지 한 번에 재계산할 수 있습니다 (요청: ${ledgerIds.length})`,
      );
    }

    const succeeded: RecalcResultItem[] = [];
    const failed: RecalcResultItem[] = [];

    for (const ledgerId of ledgerIds) {
      const result = await this.recalculateOne(ledgerId, actorId);
      if ('status' in result) {
        succeeded.push(result);
      } else {
        failed.push(result);
      }
    }

    return { succeeded, failed };
  }

  private async resolveLedgerIds(
    params: { ledgerIds: number[] } | { partnerCompanyId: number; subItemKey?: string },
  ): Promise<number[]> {
    if ('ledgerIds' in params) {
      return params.ledgerIds;
    }
    const qb = this.ledgerRepository
      .createQueryBuilder('l')
      .select('l.id')
      .where('l.partnerCompanyId = :pcId', { pcId: params.partnerCompanyId })
      .andWhere('l.status = :status', { status: 'NEEDS_REVIEW' })
      .andWhere('l.reviewCode IN (:...codes)', {
        codes: ['COVERAGE_GAP', 'POLICY_CONFLICT'],
      });
    if (params.subItemKey) {
      qb.andWhere('l.subItemKey = :sik', { sik: params.subItemKey });
    }
    qb.orderBy('l.id', 'ASC').take(MAX_RECALC_BATCH + 1);
    const rows = await qb.getMany();
    return rows.map((r) => r.id);
  }

  private async recalculateOne(ledgerId: number, actorId: number): Promise<RecalcResultItem> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const manager = qr.manager;
      const ledger = await manager
        .getRepository(PartnerSettleLedgerEntity)
        .createQueryBuilder('l')
        .setLock('pessimistic_write')
        .where('l.id = :id', { id: ledgerId })
        .getOne();

      if (!ledger) {
        await qr.rollbackTransaction();
        return { ledgerId, code: 'NOT_FOUND' };
      }

      if (ledger.status === 'ON_HOLD') {
        await qr.rollbackTransaction();
        return { ledgerId, code: 'ON_HOLD' };
      }

      if (ledger.status !== 'NEEDS_REVIEW') {
        await qr.rollbackTransaction();
        return { ledgerId, code: 'ALREADY_RESOLVED' };
      }

      if (!this.isDeterministic(ledger.reviewCode as IPartnerSettleReviewCode)) {
        await qr.rollbackTransaction();
        return { ledgerId, code: 'NOT_DETERMINISTIC' };
      }

      if (ledger.occurredAt === null || ledger.baseAmount === null) {
        // COVERAGE_GAP/POLICY_CONFLICT should have occurredAt and baseAmount set
        await qr.rollbackTransaction();
        return { ledgerId, code: 'VALIDATION_FAILED' };
      }

      // 정책 이력 공유 잠금 — 원장 경로와 동일 직렬화 수준 확보
      await this.pricingResolver.lockPolicyForRead(ledger.partnerCompanyId, manager);

      // snapshot from order_product_mapping
      const snapshot = await this.loadSnapshot(ledger.orderDeliveryId, manager);
      if (!snapshot) {
        await qr.rollbackTransaction();
        return { ledgerId, code: 'VALIDATION_FAILED' };
      }

      // 매입율 재판정 (트랜잭션 manager 사용)
      const pricing = await this.pricingResolver.resolveAt(
        ledger.partnerCompanyId,
        ledger.occurredAt,
        snapshot,
        manager,
      );

      if (pricing.status === 'NEEDS_REVIEW') {
        // 여전히 해소 불가 — 아직 이력이 안 맞다
        await qr.rollbackTransaction();
        return { ledgerId, code: 'VALIDATION_FAILED' };
      }

      // 금액 재계산
      const baseAmount = BigInt(ledger.baseAmount);
      const amounts = calculateSettleAmounts({
        baseAmount,
        pricePercent: pricing.pricePercent,
        priceAdjustment: pricing.priceAdjustment,
        vatCalculationMode: ledger.vatCalculationMode,
        discountAmount: BigInt(ledger.discountAmount ?? '0'),
      });

      // before snapshot
      const before = {
        status: ledger.status,
        reviewCode: ledger.reviewCode,
        reviewResolution: ledger.reviewResolution,
        occurredAt: ledger.occurredAt,
        baseAmount: ledger.baseAmount,
        appliedPricePercent: ledger.appliedPricePercent,
        appliedPriceAdjustment: ledger.appliedPriceAdjustment,
        settleAmount: ledger.settleAmount,
        pricingResolution: ledger.pricingResolution,
      };

      // ledger UPDATE
      await manager.getRepository(PartnerSettleLedgerEntity).update(ledger.id, {
        status: 'NORMAL',
        reviewCode: null,
        reviewResolution: null,
        appliedPricePercent: String(pricing.pricePercent),
        appliedPriceAdjustment: pricing.priceAdjustment,
        appliedDiscountHistoryId: pricing.appliedDiscountHistoryId,
        pricingResolution: pricing.pricingResolution,
        settleAmount: String(amounts.settleAmount),
        givingCommissionAmount: String(amounts.givingCommissionAmount),
        receivingCommissionAmount: String(amounts.receivingCommissionAmount),
        vatAmount: String(amounts.vatAmount),
        feeTotalAmount: String(amounts.feeTotalAmount),
        discountAmount: String(amounts.discountAmount),
      });

      // audit append
      await manager.getRepository(PartnerSettleReviewAuditEntity).insert({
        ledgerId: ledger.id,
        manualLedgerProposalId: null,
        beforeStatus: before.status,
        afterStatus: 'NORMAL',
        beforeReviewCode: before.reviewCode,
        afterReviewCode: null,
        beforeReviewResolution: before.reviewResolution,
        afterReviewResolution: null,
        beforeOccurredAt: before.occurredAt,
        afterOccurredAt: ledger.occurredAt,
        beforeBaseAmount: before.baseAmount,
        afterBaseAmount: ledger.baseAmount,
        beforeAppliedPricePercent: before.appliedPricePercent,
        afterAppliedPricePercent: String(pricing.pricePercent),
        beforeAppliedPriceAdjustment: before.appliedPriceAdjustment,
        afterAppliedPriceAdjustment: pricing.priceAdjustment,
        beforeSettleAmount: before.settleAmount,
        afterSettleAmount: String(amounts.settleAmount),
        beforePricingResolution: before.pricingResolution,
        afterPricingResolution: pricing.pricingResolution,
        actorId,
        reason: 'deterministic recalculate (COVERAGE_GAP/POLICY_CONFLICT)',
        createdAt: new Date(),
      });

      await qr.commitTransaction();
      return { ledgerId, status: 'NORMAL' };
    } catch (err) {
      await qr.rollbackTransaction();
      this.logger.error(`recalculate failed for ledgerId=${ledgerId}`, err);
      return { ledgerId, code: 'VALIDATION_FAILED' };
    } finally {
      await qr.release();
    }
  }

  private isDeterministic(reviewCode: IPartnerSettleReviewCode | null): boolean {
    return reviewCode === 'COVERAGE_GAP' || reviewCode === 'POLICY_CONFLICT';
  }

  private async loadSnapshot(
    orderDeliveryId: number | null,
    manager: EntityManager,
  ): Promise<PricingProductSnapshot | null> {
    if (orderDeliveryId === null) return null;

    const opm = await manager
      .getRepository(OrderProductMappingEntity)
      .createQueryBuilder('opm')
      .where('opm.orderDeliveryId = :odId', { odId: orderDeliveryId })
      .getOne();

    if (!opm) return null;

    return {
      price: opm.snapshotProductPrice ?? null,
      category: opm.snapshotProductCategory ?? null,
      classificationId: opm.snapshotProductClassificationId ?? null,
      brandNameKorean: opm.snapshotProductBrandName ?? null,
    };
  }
}
