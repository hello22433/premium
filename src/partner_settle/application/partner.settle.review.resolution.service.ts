import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  IReviewResolutionMode,
  PartnerSettleReviewResolutionEntity,
} from '../../entity/partner.settle.review.resolution.entity';
import { PartnerSettleReviewAuditEntity } from '../../entity/partner.settle.review.audit.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import {
  calculatePartialReversal,
  calculateSettleAmounts,
  LEDGER_AMOUNT_MAX,
  reverseAmounts,
  SettleAmountBreakdown,
  sumBreakdowns,
} from '../domain/settle.amount';
import { computeEvidenceHash, computePayloadHash } from '../domain/proposal.hash';
import { parseKstDateTime, SettleTimeParseError, toDbDateTimeString } from '../domain/settle.time';
import { PartnerSettlePricingResolverService } from './partner.settle.pricing.resolver.service';
import { PricingProductSnapshot } from '../domain/partner.settle.pricing';
import { IPartnerSettleReviewCode, IPartnerSettleSourceType } from '../interface/partner.settle.source.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { isDuplicateKeyError } from './partner.settle.raw.insert';

const HASH_VERSION = 'v1';
const MODES: readonly IReviewResolutionMode[] = ['SET_TIME', 'SET_PRICE', 'SET_UNKNOWN', 'RECLASSIFY', 'DISCARD'];

type ReviewProposeCommand = {
  ledgerId: number;
  reviewCode: IPartnerSettleReviewCode;
  resolutionMode: IReviewResolutionMode;
  proposedValues?: Record<string, unknown> | null;
  evidenceRef: string;
  reason?: string | null;
  requestKey: string;
};

type ResolutionResult = {
  proposal: PartnerSettleReviewResolutionEntity;
  ledgerIds: number[];
};

type NormalizedProposal = Omit<ReviewProposeCommand, 'proposedValues' | 'evidenceRef' | 'requestKey' | 'reason'> & {
  proposedValues: Record<string, unknown> | null;
  evidenceRef: string;
  requestKey: string;
  reason: string | null;
};

type ReclassifyFacts = {
  sourceType?: IPartnerSettleSourceType;
  subItemKey?: string;
  occurredAt: string;
  baseAmount: string;
};

/** NEEDS_REVIEW 회계 사실을 독립 propose→approve/reject로 확정한다 (정본 §5.11). */
@Injectable()
export class PartnerSettleReviewResolutionService {
  constructor(
    @InjectRepository(PartnerSettleReviewResolutionEntity)
    private readonly resolutionRepository: Repository<PartnerSettleReviewResolutionEntity>,
    private readonly pricingResolver: PartnerSettlePricingResolverService,
    private readonly dataSource: DataSource,
  ) {}

  async propose(command: ReviewProposeCommand, actorId: number): Promise<ResolutionResult> {
    const normalized = this.normalize(command);

    // 승인 후 ledger가 NORMAL이 되어도 동일 requestKey 재시도는 기존 결과로 수렴해야 한다.
    const existing = await this.resolutionRepository.findOne({ where: { requestKey: normalized.requestKey } });
    if (existing) return this.replayPropose(existing, normalized);

    try {
      return await this.dataSource.transaction(async (manager) => {
        const raced = await manager.getRepository(PartnerSettleReviewResolutionEntity).findOne({
          where: { requestKey: normalized.requestKey },
        });
        if (raced) return this.replayPropose(raced, normalized);

        const ledger = await this.lockLedger(normalized.ledgerId, manager);
        this.validateTarget(ledger, normalized);

        const payloadHash = this.payloadHash(normalized, ledger.reviewCode!);
        const inserted = manager.getRepository(PartnerSettleReviewResolutionEntity).create({
          ledgerId: ledger.id,
          reviewCode: ledger.reviewCode!,
          resolutionMode: normalized.resolutionMode,
          proposedValues: normalized.proposedValues,
          evidenceRef: normalized.evidenceRef,
          evidenceHash: computeEvidenceHash(normalized.evidenceRef),
          requestKey: normalized.requestKey,
          payloadHash,
          payloadHashVersion: HASH_VERSION,
          status: 'PENDING',
          proposedBy: actorId,
          proposedAt: new Date(),
          decidedBy: null,
          decidedAt: null,
          decisionReason: normalized.reason,
        });
        const proposal = await manager.getRepository(PartnerSettleReviewResolutionEntity).save(inserted);
        return { proposal, ledgerIds: [] };
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.resolutionRepository.findOne({ where: { requestKey: normalized.requestKey } });
      if (raced) return this.replayPropose(raced, normalized);
      throw new ConflictException('해당 원장에 이미 활성 검토 제안이 있습니다.');
    }
  }

  async approve(proposalId: number, actorId: number, decisionReason?: string | null): Promise<ResolutionResult> {
    return this.dataSource.transaction(async (manager) => {
      const proposal = await this.lockProposal(proposalId, manager);
      if (proposal.status === 'APPROVED') return this.resultFor(proposal, manager);
      if (proposal.status === 'REJECTED') throw new ConflictException('이미 반려된 검토 제안입니다.');
      if (proposal.proposedBy === actorId) throw new ForbiddenException('제안자는 자신의 제안을 승인할 수 없습니다.');

      const ledger = await this.lockLedger(proposal.ledgerId, manager);
      this.validateApprovalTarget(ledger, proposal);
      const decidedAt = new Date();
      const normalizedReason = this.optionalText(decisionReason, 1000);
      proposal.decisionReason = normalizedReason;
      const ledgerIds = await this.applyResolution(ledger, proposal, actorId, decidedAt, manager);

      const changed = await manager
        .getRepository(PartnerSettleReviewResolutionEntity)
        .update(
          { id: proposal.id, status: 'PENDING' },
          { status: 'APPROVED', decidedBy: actorId, decidedAt, decisionReason: normalizedReason },
        );
      if (changed.affected !== 1) throw new ConflictException('검토 제안 상태가 동시에 변경되었습니다.');

      return {
        proposal: { ...proposal, status: 'APPROVED', decidedBy: actorId, decidedAt },
        ledgerIds,
      };
    });
  }

  async reject(proposalId: number, actorId: number, reason: string): Promise<ResolutionResult> {
    const normalizedReason = this.requiredText(reason, '반려 사유', 1000);
    return this.dataSource.transaction(async (manager) => {
      const proposal = await this.lockProposal(proposalId, manager);
      if (proposal.status === 'REJECTED') return { proposal, ledgerIds: [] };
      if (proposal.status === 'APPROVED') throw new ConflictException('이미 승인된 검토 제안입니다.');
      if (proposal.proposedBy === actorId) throw new ForbiddenException('제안자는 자신의 제안을 반려할 수 없습니다.');

      const decidedAt = new Date();
      const changed = await manager
        .getRepository(PartnerSettleReviewResolutionEntity)
        .update(
          { id: proposal.id, status: 'PENDING' },
          { status: 'REJECTED', decidedBy: actorId, decidedAt, decisionReason: normalizedReason },
        );
      if (changed.affected !== 1) throw new ConflictException('검토 제안 상태가 동시에 변경되었습니다.');
      return {
        proposal: { ...proposal, status: 'REJECTED', decidedBy: actorId, decidedAt, decisionReason: normalizedReason },
        ledgerIds: [],
      };
    });
  }

  private async applyResolution(
    ledger: PartnerSettleLedgerEntity,
    proposal: PartnerSettleReviewResolutionEntity,
    actorId: number,
    decidedAt: Date,
    manager: EntityManager,
  ): Promise<number[]> {
    const before = this.auditSnapshot(ledger);
    let resultIds: number[];

    switch (proposal.resolutionMode) {
      case 'DISCARD':
        await this.discardPlaceholder(ledger, proposal, actorId, decidedAt, manager);
        resultIds = [];
        break;
      case 'SET_TIME':
      case 'SET_PRICE':
      case 'SET_UNKNOWN':
        await this.normalizeInPlace(ledger, proposal, manager);
        resultIds = [ledger.id];
        break;
      case 'RECLASSIFY':
        resultIds = await this.reclassify(ledger, proposal, actorId, decidedAt, manager);
        break;
    }

    const after = await manager.getRepository(PartnerSettleLedgerEntity).findOneByOrFail({ id: ledger.id });
    await manager.getRepository(PartnerSettleReviewAuditEntity).insert({
      ledgerId: ledger.id,
      manualLedgerProposalId: null,
      ...this.auditColumns(before, this.auditSnapshot(after)),
      providerEvidenceRef: proposal.evidenceRef,
      providerEvidenceHash: proposal.evidenceHash,
      priceEvidenceRef: this.stringValue(proposal.proposedValues?.priceEvidenceRef) ?? null,
      resolutionId: proposal.id,
      actorId,
      reason: proposal.decisionReason ?? `review resolution ${proposal.resolutionMode}`,
      createdAt: decidedAt,
    });
    return resultIds;
  }

  private async normalizeInPlace(
    ledger: PartnerSettleLedgerEntity,
    proposal: PartnerSettleReviewResolutionEntity,
    manager: EntityManager,
  ): Promise<void> {
    const values = proposal.proposedValues ?? {};
    const occurredAtRaw = this.stringValue(values.occurredAt);
    const baseAmountRaw = this.stringValue(values.baseAmount);
    const occurredAt = occurredAtRaw ? parseKstDateTime(occurredAtRaw) : null;
    const finalOccurredAt = occurredAt?.date ?? ledger.occurredAt;
    const finalBaseAmount = baseAmountRaw ?? ledger.baseAmount;
    if (!finalOccurredAt || finalBaseAmount === null)
      throw new UnprocessableEntityException('정산 시각과 금액이 모두 확정되어야 합니다.');

    const snapshot = await this.loadSnapshot(ledger.orderDeliveryId, manager);
    if (!snapshot) throw new UnprocessableEntityException('상품 불변 스냅샷을 찾을 수 없습니다.');
    await this.pricingResolver.lockPolicyForRead(ledger.partnerCompanyId, manager);
    const pricing = await this.pricingResolver.resolveAt(ledger.partnerCompanyId, finalOccurredAt, snapshot, manager);
    if (pricing.status === 'NEEDS_REVIEW')
      throw new UnprocessableEntityException('확정값으로도 매입 조건을 판정할 수 없습니다.');

    const amounts = calculateSettleAmounts({
      baseAmount: BigInt(finalBaseAmount),
      discountAmount: BigInt(ledger.discountAmount ?? '0'),
      pricePercent: pricing.pricePercent,
      priceAdjustment: pricing.priceAdjustment,
      vatCalculationMode: ledger.vatCalculationMode,
    });
    const occurredAtSql = occurredAt ? toDbDateTimeString(occurredAt) : null;
    await manager.query(
      `UPDATE partner_settle_ledger SET
       occurred_at = COALESCE(?, occurred_at), base_amount = ?, status = 'NORMAL', review_code = NULL,
       review_resolution = NULL, resolved_by = NULL, resolved_at = NULL,
       applied_price_percent = ?, applied_price_adjustment = ?, applied_discount_history_id = ?,
       pricing_resolution = ?, settle_amount = ?, discount_amount = ?, receiving_commission_amount = ?,
       giving_commission_amount = ?, vat_amount = ?, fee_total_amount = ? WHERE id = ?`,
      [
        occurredAtSql,
        String(amounts.baseAmount),
        String(pricing.pricePercent),
        pricing.priceAdjustment,
        pricing.appliedDiscountHistoryId,
        pricing.pricingResolution,
        String(amounts.settleAmount),
        String(amounts.discountAmount),
        String(amounts.receivingCommissionAmount),
        String(amounts.givingCommissionAmount),
        String(amounts.vatAmount),
        String(amounts.feeTotalAmount),
        ledger.id,
      ],
    );
  }

  private async discardPlaceholder(
    ledger: PartnerSettleLedgerEntity,
    proposal: PartnerSettleReviewResolutionEntity,
    actorId: number,
    decidedAt: Date,
    manager: EntityManager,
  ): Promise<void> {
    await manager.getRepository(PartnerSettleLedgerEntity).update(ledger.id, {
      reviewResolution: 'DISCARDED',
      resolvedBy: actorId,
      resolvedAt: decidedAt,
      memo: proposal.decisionReason ?? proposal.evidenceRef,
    });
  }

  private async reclassify(
    ledger: PartnerSettleLedgerEntity,
    proposal: PartnerSettleReviewResolutionEntity,
    actorId: number,
    decidedAt: Date,
    manager: EntityManager,
  ): Promise<number[]> {
    await this.discardPlaceholder(ledger, proposal, actorId, decidedAt, manager);
    const facts = this.reclassifyFacts(proposal.proposedValues, ledger);
    const baseAmount = BigInt(facts.baseAmount);
    if (baseAmount === 0n) throw new BadRequestException('RECLASSIFY baseAmount는 0일 수 없습니다.');

    if (baseAmount < 0n) {
      return this.appendReclassifiedReversals(ledger, proposal, facts, manager);
    }
    const idempotencyKey = `REVIEW:RECLASS:${proposal.id}:1`;
    const existing = await manager.getRepository(PartnerSettleLedgerEntity).findOne({ where: { idempotencyKey } });
    if (existing) return [existing.id];

    const snapshot = await this.loadSnapshot(ledger.orderDeliveryId, manager);
    if (!snapshot) throw new UnprocessableEntityException('상품 불변 스냅샷을 찾을 수 없습니다.');
    const instant = parseKstDateTime(facts.occurredAt);
    await this.pricingResolver.lockPolicyForRead(ledger.partnerCompanyId, manager);
    const pricing = await this.pricingResolver.resolveAt(ledger.partnerCompanyId, instant.date, snapshot, manager);
    if (pricing.status === 'NEEDS_REVIEW')
      throw new UnprocessableEntityException('재분류 값으로 매입 조건을 판정할 수 없습니다.');
    const amounts = calculateSettleAmounts({
      baseAmount,
      pricePercent: pricing.pricePercent,
      priceAdjustment: pricing.priceAdjustment,
      vatCalculationMode: ledger.vatCalculationMode,
      discountAmount: 0n,
    });

    await manager.query(
      `INSERT INTO partner_settle_ledger
       (partner_company_id, sub_item_key, source_type, order_delivery_id, galaxia_barcode_log_id,
        occurred_at, base_amount, discount_amount, receiving_commission_amount, giving_commission_amount,
        vat_amount, vat_calculation_mode, fee_total_amount, applied_price_percent,
        applied_price_adjustment, applied_discount_history_id, pricing_resolution, settle_amount,
        idempotency_key, settle_batch_id, status, review_code, review_resolution, resolved_by,
        resolved_at, provider_evidence_ref, provider_evidence_hash, memo, reverses_ledger_id,
        transition_observation_id, transition_sequence_no, source_event_id_origin,
        review_resolution_id, manual_ledger_proposal_id, orphan_inbox_row_id, payment_variance_proposal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'NORMAL', NULL, NULL,
               NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL)`,
      [
        ledger.partnerCompanyId,
        facts.subItemKey!,
        facts.sourceType!,
        ledger.orderDeliveryId,
        ledger.galaxiaBarcodeLogId,
        toDbDateTimeString(instant),
        String(amounts.baseAmount),
        String(amounts.discountAmount),
        String(amounts.receivingCommissionAmount),
        String(amounts.givingCommissionAmount),
        String(amounts.vatAmount),
        ledger.vatCalculationMode,
        String(amounts.feeTotalAmount),
        String(pricing.pricePercent),
        pricing.priceAdjustment,
        pricing.appliedDiscountHistoryId,
        pricing.pricingResolution,
        String(amounts.settleAmount),
        idempotencyKey,
        proposal.evidenceRef,
        proposal.evidenceHash,
        proposal.decisionReason,
        proposal.id,
      ],
    );
    const inserted = await manager.getRepository(PartnerSettleLedgerEntity).findOneByOrFail({ idempotencyKey });
    return [inserted.id];
  }

  private async appendReclassifiedReversals(
    placeholder: PartnerSettleLedgerEntity,
    proposal: PartnerSettleReviewResolutionEntity,
    facts: ReclassifyFacts,
    manager: EntityManager,
  ): Promise<number[]> {
    let remaining = -BigInt(facts.baseAmount);
    const originals = await manager
      .getRepository(PartnerSettleLedgerEntity)
      .createQueryBuilder('l')
      .setLock('pessimistic_write')
      .where('l.orderDeliveryId = :orderDeliveryId', { orderDeliveryId: placeholder.orderDeliveryId })
      .andWhere('l.partnerCompanyId = :partnerCompanyId', { partnerCompanyId: placeholder.partnerCompanyId })
      .andWhere('l.reversesLedgerId IS NULL')
      .andWhere('l.status = :status', { status: 'NORMAL' })
      .andWhere('l.baseAmount > 0')
      .orderBy('l.id', 'ASC')
      .getMany();
    const ids: number[] = [];

    for (const original of originals) {
      if (remaining === 0n) break;
      const prior = await manager
        .getRepository(PartnerSettleLedgerEntity)
        .find({ where: { reversesLedgerId: original.id } });
      const originalAmounts = toBreakdown(original);
      const reversedTotals = sumBreakdowns(prior.map(toBreakdown));
      const remainingAmounts = sumBreakdowns([originalAmounts, reversedTotals]);
      const available = remainingAmounts.baseAmount;
      if (available <= 0n) continue;
      const allocation = remaining < available ? remaining : available;
      const key = `REVIEW:RECLASS:${proposal.id}:${original.id}`;
      const existing = await manager
        .getRepository(PartnerSettleLedgerEntity)
        .findOne({ where: { idempotencyKey: key } });
      if (existing) {
        ids.push(existing.id);
        remaining -= -BigInt(existing.baseAmount ?? '0');
        continue;
      }
      if (
        original.appliedPricePercent === null ||
        original.appliedPriceAdjustment === null ||
        original.pricingResolution === null
      )
        throw new UnprocessableEntityException(`역분개 대상 원장 ${original.id}의 가격 스냅샷이 없습니다.`);
      const amounts =
        allocation === available
          ? reverseAmounts(remainingAmounts)
          : calculatePartialReversal({
              original: originalAmounts,
              cancelBaseAmount: allocation,
              reversedTotals,
              pricePercent: original.appliedPricePercent,
              priceAdjustment: original.appliedPriceAdjustment,
              vatCalculationMode: original.vatCalculationMode,
            });
      const instant = parseKstDateTime(facts.occurredAt);
      await manager.query(
        `INSERT INTO partner_settle_ledger
         (partner_company_id, sub_item_key, source_type, order_delivery_id, galaxia_barcode_log_id,
          occurred_at, base_amount, discount_amount, receiving_commission_amount, giving_commission_amount,
          vat_amount, vat_calculation_mode, fee_total_amount, applied_price_percent,
          applied_price_adjustment, applied_discount_history_id, pricing_resolution, settle_amount,
          idempotency_key, settle_batch_id, status, review_code, review_resolution, resolved_by,
          resolved_at, provider_evidence_ref, provider_evidence_hash, memo, reverses_ledger_id,
          transition_observation_id, transition_sequence_no, source_event_id_origin,
          review_resolution_id, manual_ledger_proposal_id, orphan_inbox_row_id, payment_variance_proposal_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL,
                 NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL)`,
        [
          original.partnerCompanyId,
          original.subItemKey,
          original.sourceType,
          original.orderDeliveryId,
          placeholder.galaxiaBarcodeLogId,
          toDbDateTimeString(instant),
          String(amounts.baseAmount),
          String(amounts.discountAmount),
          String(amounts.receivingCommissionAmount),
          String(amounts.givingCommissionAmount),
          String(amounts.vatAmount),
          original.vatCalculationMode,
          String(amounts.feeTotalAmount),
          original.appliedPricePercent,
          original.appliedPriceAdjustment,
          original.appliedDiscountHistoryId,
          original.pricingResolution,
          String(amounts.settleAmount),
          key,
          original.status,
          proposal.evidenceRef,
          proposal.evidenceHash,
          proposal.decisionReason,
          original.id,
          proposal.id,
        ],
      );
      const inserted = await manager.getRepository(PartnerSettleLedgerEntity).findOneByOrFail({ idempotencyKey: key });
      ids.push(inserted.id);
      remaining -= allocation;
    }
    if (remaining !== 0n) throw new UnprocessableEntityException('역분개 가능한 원장 잔액이 부족합니다.');
    return ids;
  }

  private validateTarget(ledger: PartnerSettleLedgerEntity, command: NormalizedProposal): void {
    if (ledger.status !== 'NEEDS_REVIEW' || ledger.reviewResolution !== 'PENDING') {
      throw new ConflictException('미해소 NEEDS_REVIEW 원장만 제안할 수 있습니다.');
    }
    if (ledger.reviewCode !== command.reviewCode)
      throw new ConflictException('요청 reviewCode가 현재 원장과 다릅니다.');
    const expected: Partial<Record<IReviewResolutionMode, IPartnerSettleReviewCode>> = {
      SET_TIME: 'TIME_UNRECOVERABLE',
      SET_PRICE: 'PRICE_UNRECOVERABLE',
      SET_UNKNOWN: 'UNKNOWN_PROVIDER_EVENT',
      RECLASSIFY: 'UNKNOWN_PROVIDER_EVENT',
      DISCARD: 'UNKNOWN_PROVIDER_EVENT',
    };
    if (expected[command.resolutionMode] !== ledger.reviewCode) {
      throw new BadRequestException('reviewCode와 resolutionMode 조합이 올바르지 않습니다.');
    }
    this.validateValues(command.resolutionMode, command.proposedValues, ledger);
  }

  private validateApprovalTarget(
    ledger: PartnerSettleLedgerEntity,
    proposal: PartnerSettleReviewResolutionEntity,
  ): void {
    if (
      ledger.status !== 'NEEDS_REVIEW' ||
      ledger.reviewResolution !== 'PENDING' ||
      ledger.reviewCode !== proposal.reviewCode
    )
      throw new ConflictException('원장의 검토 상태가 제안 이후 변경되었습니다.');
    this.validateValues(proposal.resolutionMode, proposal.proposedValues, ledger);
  }

  private validateValues(
    mode: IReviewResolutionMode,
    values: Record<string, unknown> | null,
    ledger: PartnerSettleLedgerEntity,
  ): void {
    const input = values ?? {};
    try {
      if (mode === 'DISCARD') {
        if (Object.keys(input).length > 0) throw new BadRequestException('DISCARD는 proposedValues를 받지 않습니다.');
        return;
      }
      if (mode === 'SET_TIME') {
        this.assertExactKeys(input, ['occurredAt'], mode);
        if (ledger.occurredAt !== null) throw new ConflictException('occurredAt은 이미 설정되어 있습니다.');
        parseKstDateTime(this.requiredStringValue(input.occurredAt, 'occurredAt'));
        return;
      }
      if (mode === 'SET_PRICE') {
        this.assertExactKeys(input, ['baseAmount', 'priceEvidenceRef'], mode);
        if (ledger.baseAmount !== null) throw new ConflictException('baseAmount는 이미 설정되어 있습니다.');
        this.positiveAmount(input.baseAmount, 'baseAmount');
        this.requiredEvidenceRef(input.priceEvidenceRef, 'priceEvidenceRef');
        return;
      }
      if (mode === 'SET_UNKNOWN') {
        this.assertExactKeys(
          input,
          ledger.occurredAt === null ? ['isSettlement', 'baseAmount', 'occurredAt'] : ['isSettlement', 'baseAmount'],
          mode,
        );
        if (input.isSettlement !== true) throw new BadRequestException('SET_UNKNOWN은 isSettlement=true가 필요합니다.');
        this.positiveAmount(input.baseAmount, 'baseAmount');
        if (ledger.occurredAt === null) parseKstDateTime(this.requiredStringValue(input.occurredAt, 'occurredAt'));
        return;
      }
      this.assertExactKeys(input, ['reclassifyTo'], mode);
      this.reclassifyFacts(values);
    } catch (error) {
      if (error instanceof SettleTimeParseError || error instanceof SyntaxError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private reclassifyFacts(values: Record<string, unknown> | null, ledger?: PartnerSettleLedgerEntity): ReclassifyFacts {
    const raw = values?.reclassifyTo;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('RECLASSIFY는 reclassifyTo가 필요합니다.');
    }
    const target = raw as Record<string, unknown>;
    this.assertExactKeys(target, ['sourceType', 'subItemKey', 'occurredAt', 'baseAmount'], 'RECLASSIFY reclassifyTo');
    const sourceTypeRaw = target.sourceType;
    const sourceType =
      sourceTypeRaw === undefined ? ledger?.sourceType : this.requiredStringValue(sourceTypeRaw, 'sourceType');
    if (sourceType && !['ISSUANCE', 'EXCHANGE', 'USAGE'].includes(sourceType)) {
      throw new BadRequestException('RECLASSIFY sourceType이 올바르지 않습니다.');
    }
    if (!sourceType && ledger) throw new BadRequestException('sourceType가 필요합니다.');
    const subItemKey =
      target.subItemKey === undefined ? ledger?.subItemKey : this.requiredStringValue(target.subItemKey, 'subItemKey');
    if (!subItemKey && ledger) throw new BadRequestException('subItemKey가 필요합니다.');
    const occurredAt = this.requiredStringValue(target.occurredAt, 'occurredAt');
    parseKstDateTime(occurredAt);
    const baseAmount = this.amount(target.baseAmount, 'baseAmount');
    return { sourceType: sourceType as IPartnerSettleSourceType, subItemKey, occurredAt, baseAmount };
  }

  private normalize(command: ReviewProposeCommand): NormalizedProposal {
    if (!Number.isInteger(command.ledgerId) || command.ledgerId <= 0)
      throw new BadRequestException('ledgerId가 올바르지 않습니다.');
    if (!MODES.includes(command.resolutionMode)) throw new BadRequestException('resolutionMode가 올바르지 않습니다.');
    return {
      ledgerId: command.ledgerId,
      reviewCode: command.reviewCode,
      resolutionMode: command.resolutionMode,
      proposedValues: this.normalizeProposedValues(command.proposedValues ?? null, command.resolutionMode),
      evidenceRef: this.requiredEvidenceRef(command.evidenceRef, 'evidenceRef'),
      reason: this.optionalText(command.reason, 1000),
      requestKey: this.requestKey(command.requestKey),
    };
  }

  private replayPropose(existing: PartnerSettleReviewResolutionEntity, command: NormalizedProposal): ResolutionResult {
    const expected = this.payloadHash(command, existing.reviewCode as IPartnerSettleReviewCode);
    if (existing.payloadHashVersion !== HASH_VERSION || existing.payloadHash !== expected) {
      throw new ConflictException('같은 requestKey에 다른 요청 payload가 이미 등록되었습니다.');
    }
    return { proposal: existing, ledgerIds: [] };
  }

  private payloadHash(command: NormalizedProposal, reviewCode: string): string {
    return computePayloadHash(
      {
        ledgerId: command.ledgerId,
        reviewCode,
        resolutionMode: command.resolutionMode,
        proposedValues: command.proposedValues,
        evidenceRef: command.evidenceRef,
        reason: command.reason,
        requestKey: command.requestKey,
      },
      HASH_VERSION,
    );
  }

  private async resultFor(
    proposal: PartnerSettleReviewResolutionEntity,
    manager: EntityManager,
  ): Promise<ResolutionResult> {
    const rows =
      proposal.resolutionMode === 'RECLASSIFY'
        ? await manager
            .getRepository(PartnerSettleLedgerEntity)
            .find({ where: { reviewResolutionId: proposal.id }, order: { id: 'ASC' } })
        : proposal.resolutionMode === 'DISCARD'
          ? []
          : await manager.getRepository(PartnerSettleLedgerEntity).find({ where: { id: proposal.ledgerId } });
    return { proposal, ledgerIds: rows.map((row) => row.id) };
  }

  private async lockProposal(id: number, manager: EntityManager): Promise<PartnerSettleReviewResolutionEntity> {
    const row = await manager
      .getRepository(PartnerSettleReviewResolutionEntity)
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.id = :id', { id })
      .getOne();
    if (!row) throw new NotFoundException('검토 제안을 찾을 수 없습니다.');
    return row;
  }

  private async lockLedger(id: number, manager: EntityManager): Promise<PartnerSettleLedgerEntity> {
    const row = await manager
      .getRepository(PartnerSettleLedgerEntity)
      .createQueryBuilder('l')
      .setLock('pessimistic_write')
      .where('l.id = :id', { id })
      .getOne();
    if (!row) throw new NotFoundException('정산 원장을 찾을 수 없습니다.');
    return row;
  }

  private async loadSnapshot(
    orderDeliveryId: number | null,
    manager: EntityManager,
  ): Promise<PricingProductSnapshot | null> {
    if (orderDeliveryId === null) return null;
    const opm = await manager
      .getRepository(OrderProductMappingEntity)
      .createQueryBuilder('opm')
      .where('opm.orderDeliveryId = :orderDeliveryId', { orderDeliveryId })
      .getOne();
    if (!opm) return null;
    return {
      price: opm.snapshotProductPrice ?? null,
      category: opm.snapshotProductCategory ?? null,
      classificationId: opm.snapshotProductClassificationId ?? null,
      brandNameKorean: opm.snapshotProductBrandName ?? null,
    };
  }

  private auditSnapshot(ledger: PartnerSettleLedgerEntity) {
    return {
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
  }

  private auditColumns(
    before: ReturnType<PartnerSettleReviewResolutionService['auditSnapshot']>,
    after: ReturnType<PartnerSettleReviewResolutionService['auditSnapshot']>,
  ) {
    return {
      beforeStatus: before.status,
      afterStatus: after.status,
      beforeReviewCode: before.reviewCode,
      afterReviewCode: after.reviewCode,
      beforeReviewResolution: before.reviewResolution,
      afterReviewResolution: after.reviewResolution,
      beforeOccurredAt: before.occurredAt,
      afterOccurredAt: after.occurredAt,
      beforeBaseAmount: before.baseAmount,
      afterBaseAmount: after.baseAmount,
      beforeAppliedPricePercent: before.appliedPricePercent,
      afterAppliedPricePercent: after.appliedPricePercent,
      beforeAppliedPriceAdjustment: before.appliedPriceAdjustment as IPriceAdjustment | null,
      afterAppliedPriceAdjustment: after.appliedPriceAdjustment as IPriceAdjustment | null,
      beforeSettleAmount: before.settleAmount,
      afterSettleAmount: after.settleAmount,
      beforePricingResolution: before.pricingResolution,
      afterPricingResolution: after.pricingResolution,
    };
  }

  private assertExactKeys(input: Record<string, unknown>, allowed: readonly string[], mode: string): void {
    const invalid = Object.keys(input).find((key) => !allowed.includes(key));
    if (invalid) throw new BadRequestException(`${mode}는 ${invalid} 값을 받을 수 없습니다.`);
  }
  private positiveAmount(value: unknown, field: string): string {
    const amount = this.amount(value, field);
    if (BigInt(amount) <= 0n) throw new BadRequestException(`${field}는 0보다 큰 정수여야 합니다.`);
    return amount;
  }

  private amount(value: unknown, field: string): string {
    if (typeof value !== 'string' || !/^(0|-?[1-9]\d*)$/.test(value))
      throw new BadRequestException(`${field}는 canonical 정수 문자열이어야 합니다.`);
    const amount = BigInt(value);
    const absolute = amount < 0n ? -amount : amount;
    if (absolute > LEDGER_AMOUNT_MAX) throw new BadRequestException(`${field}가 단건 상한을 초과했습니다.`);
    return String(amount);
  }

  private requiredStringValue(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') throw new BadRequestException(`${field}가 필요합니다.`);
    return value.trim();
  }

  private stringValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }

  private requiredEvidenceRef(value: unknown, field: string): string {
    const text = this.requiredText(value, field, 1000);
    if (/[\u0000-\u001F\u007F-\u009F]/u.test(text))
      throw new BadRequestException(`${field}에 제어문자를 포함할 수 없습니다.`);
    return text;
  }

  private requestKey(value: unknown): string {
    const key = this.requiredText(value, 'requestKey', 128);
    if (!/^[A-Za-z0-9_-]+$/.test(key))
      throw new BadRequestException('requestKey는 영문, 숫자, 밑줄, 하이픈만 사용할 수 있습니다.');
    return key;
  }

  private requiredText(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string') throw new BadRequestException(`${field}가 필요합니다.`);
    const text = value.normalize('NFC').trim();
    if (!text) throw new BadRequestException(`${field}가 필요합니다.`);
    if (text.length > max) throw new BadRequestException(`${field}는 ${max}자를 초과할 수 없습니다.`);
    return text;
  }

  private optionalText(value: unknown, max: number): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') throw new BadRequestException('문자열 값이 필요합니다.');
    const text = value.normalize('NFC').trim();
    if (text.length > max) throw new BadRequestException(`${max}자를 초과할 수 없습니다.`);
    return text || null;
  }

  private normalizeProposedValues(
    values: Record<string, unknown> | null,
    mode: IReviewResolutionMode,
  ): Record<string, unknown> | null {
    this.validateRawProposalAmounts(values, mode);
    return this.normalizePayloadValue(values) as Record<string, unknown> | null;
  }

  private validateRawProposalAmounts(values: Record<string, unknown> | null, mode: IReviewResolutionMode): void {
    const input = values ?? {};
    if (mode === 'SET_PRICE' || mode === 'SET_UNKNOWN') this.validateRawAmount(input.baseAmount);
    if (mode === 'RECLASSIFY') {
      const target = input.reclassifyTo;
      if (target && typeof target === 'object' && !Array.isArray(target))
        this.validateRawAmount((target as Record<string, unknown>).baseAmount);
    }
  }

  private validateRawAmount(value: unknown): void {
    if (typeof value === 'string' && !/^(0|-?[1-9]\d*)$/.test(value))
      throw new BadRequestException('baseAmount는 canonical 정수 문자열이어야 합니다.');
  }

  private normalizePayloadValue(value: unknown): unknown {
    if (typeof value === 'string') return value.normalize('NFC').trim() || null;
    if (Array.isArray(value)) return value.map((item) => this.normalizePayloadValue(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, item]) => [key, this.normalizePayloadValue(item)] as const)
          .filter(([, item]) => item !== null),
      );
    }
    return value;
  }
}

function toBreakdown(row: PartnerSettleLedgerEntity): SettleAmountBreakdown {
  return {
    baseAmount: BigInt(row.baseAmount ?? '0'),
    discountAmount: BigInt(row.discountAmount ?? '0'),
    receivingCommissionAmount: BigInt(row.receivingCommissionAmount ?? '0'),
    givingCommissionAmount: BigInt(row.givingCommissionAmount ?? '0'),
    vatAmount: BigInt(row.vatAmount ?? '0'),
    feeTotalAmount: BigInt(row.feeTotalAmount ?? '0'),
    settleAmount: BigInt(row.settleAmount ?? '0'),
  };
}
