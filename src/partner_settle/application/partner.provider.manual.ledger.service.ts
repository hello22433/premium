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
  PartnerProviderManualLedgerProposalEntity,
  IManualLedgerResolutionMode,
} from '../../entity/partner.provider.manual.ledger.proposal.entity';
import { PartnerProviderEventInboxEntity } from '../../entity/partner.provider.event.inbox.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerSettleReviewAuditEntity } from '../../entity/partner.settle.review.audit.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { computeEvidenceHash, computePayloadHash } from '../domain/proposal.hash';
import { resolveSourceType } from '../domain/settle.source.type.mapping';
import { resolveSubItemKey } from '../domain/settle.sub.item.key';
import { parseKstDateTime, SettleTimeParseError } from '../domain/settle.time';
import { buildSettlementContext } from './partner.settle.context.builder';
import { SettlementContext } from './partner.settle.producer.service';
import { PartnerSettleLedgerService } from './partner.settle.ledger.service';
import { isDuplicateKeyError } from './partner.settle.raw.insert';

const VERSION = 'v1';
type Propose = {
  provider: string;
  inboxRowId: number;
  resolutionMode?: IManualLedgerResolutionMode;
  proposedLedgerFacts?: Record<string, unknown> | null;
  evidenceRef: string;
  reason: string;
  requestKey: string;
  orderDeliveryId?: unknown;
  sourceType?: unknown;
};

/** appDiv 10 = 양수 사용(record), 20/25/81 = 음수 취소(recordCancellation). §6.5 Galaxia daily. */
const GALAXIA_FORWARD_APP_DIVS: ReadonlySet<string> = new Set(['10']);
const GALAXIA_REVERSAL_APP_DIVS: ReadonlySet<string> = new Set(['20', '25', '81']);
/** GiftShow pinStatusCd: 01=발행(정상), 02=교환(정상) → 양수. §4.1 GiftShow daily. */
const GIFTSHOW_FORWARD_PIN_STATUS: ReadonlySet<string> = new Set(['01', '02']);
/** GiftShow pinStatusCd: 07=취소 → 음수. */
const GIFTSHOW_REVERSAL_PIN_STATUS: ReadonlySet<string> = new Set(['07']);

@Injectable()
export class PartnerProviderManualLedgerService {
  constructor(
    @InjectRepository(PartnerProviderManualLedgerProposalEntity)
    private readonly proposals: Repository<PartnerProviderManualLedgerProposalEntity>,
    private readonly dataSource: DataSource,
    private readonly ledgerService: PartnerSettleLedgerService,
  ) {}

  async propose(command: Propose, actorId: number) {
    if (command.orderDeliveryId !== undefined || command.sourceType !== undefined)
      throw new BadRequestException('orderDeliveryId와 sourceType은 서버가 도출합니다.');
    const normalized = this.normalize(command);
    const existing = await this.proposals.findOne({ where: { requestKey: normalized.requestKey } });
    if (existing) return this.replay(existing, normalized);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const raced = await manager
          .getRepository(PartnerProviderManualLedgerProposalEntity)
          .findOne({ where: { requestKey: normalized.requestKey } });
        if (raced) return this.replay(raced, normalized);
        const candidate = await manager
          .getRepository(PartnerProviderEventInboxEntity)
          .findOne({ where: { id: normalized.inboxRowId } });
        if (!candidate) throw new BadRequestException('orphan inbox를 찾을 수 없습니다.');
        await this.lockOrderDelivery(candidate.orderDeliveryId, manager);
        const inbox = await this.lockInbox(normalized.inboxRowId, manager);
        this.assertInbox(inbox, normalized.provider);
        const context = await this.settlementContext(inbox, manager);
        if (inbox.sourceType !== resolveSourceType(context.settleMethod!))
          throw new BadRequestException('orphan inbox sourceType이 발송 상품 정산방식과 일치하지 않습니다.');
        if (normalized.proposedLedgerFacts) this.validateProposedFacts(normalized.proposedLedgerFacts, inbox, context);
        const assertionHash = computePayloadHash(
          {
            provider: inbox.provider,
            orderDeliveryId: inbox.orderDeliveryId,
            sourceType: inbox.sourceType,
            inboxRowId: inbox.id,
          },
          VERSION,
        );
        const active = await manager
          .getRepository(PartnerProviderManualLedgerProposalEntity)
          .findOne({ where: { assertionHash, status: 'PENDING' } });
        if (active) {
          const hash = this.hash(normalized, inbox);
          if (active.payloadHash === hash) return { proposal: active, ledgerIds: [] };
          throw new ConflictException('해당 orphan 사건에 활성 제안이 있습니다.');
        }
        const sourceType = resolveSourceType(context.settleMethod!);
        if (sourceType === 'EXCLUDED') {
          throw new BadRequestException('PREPAID_INVENTORY 상품은 수동 원장 제안 대상이 아닙니다.');
        }
        const proposal = manager.getRepository(PartnerProviderManualLedgerProposalEntity).create({
          provider: inbox.provider,
          orderDeliveryId: inbox.orderDeliveryId,
          sourceType,
          inboxRowId: inbox.id,
          sourceEvidencePayload: inbox.normalizedPayload,
          proposedLedgerFacts: normalized.proposedLedgerFacts,
          resolutionMode: normalized.resolutionMode,
          evidenceRef: normalized.evidenceRef,
          evidenceHash: computeEvidenceHash(normalized.evidenceRef),
          reason: normalized.reason,
          proposedBy: actorId,
          requestKey: normalized.requestKey,
          payloadHash: this.hash(normalized, inbox),
          payloadHashVersion: VERSION,
          assertionHash,
          status: 'PENDING',
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
        });
        const saved = await manager.getRepository(PartnerProviderManualLedgerProposalEntity).save(proposal);
        return { proposal: saved, ledgerIds: [] };
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.proposals.findOne({ where: { requestKey: normalized.requestKey } });
      if (raced) return this.replay(raced, normalized);
      const approved = await this.proposals.findOne({
        where: { inboxRowId: normalized.inboxRowId, status: 'APPROVED' },
      });
      if (approved) throw new ConflictException('이미 승인된 orphan 사건입니다.');
      const active = await this.proposals.findOne({
        where: { inboxRowId: normalized.inboxRowId, status: 'PENDING' },
      });
      if (active) {
        const requestedHash = computePayloadHash(
          {
            provider: normalized.provider,
            inboxRowId: normalized.inboxRowId,
            resolutionMode: normalized.resolutionMode,
            proposedLedgerFacts: normalized.proposedLedgerFacts,
            evidenceRef: normalized.evidenceRef,
            reason: normalized.reason,
            requestKey: normalized.requestKey,
          },
          VERSION,
        );
        if (active.payloadHash === requestedHash) return { proposal: active, ledgerIds: [] };
        throw new ConflictException('해당 orphan 사건에 활성 제안이 있습니다.');
      }
      throw new ConflictException('orphan 제안이 동시에 변경되었습니다.');
    }
  }

  async approve(id: number, actorId: number, decisionReason?: string | null) {
    return this.decide(id, actorId, decisionReason, 'APPROVED');
  }
  async reject(id: number, actorId: number, reason: string) {
    return this.decide(id, actorId, reason, 'REJECTED');
  }

  private async decide(
    id: number,
    actorId: number,
    reason: string | null | undefined,
    decision: 'APPROVED' | 'REJECTED',
  ) {
    const decisionReason =
      decision === 'REJECTED'
        ? this.text(reason, 'decisionReason', 1000)
        : this.optionalText(reason, 'decisionReason', 1000);
    return this.dataSource.transaction(async (manager) => {
      const located = await manager.getRepository(PartnerProviderManualLedgerProposalEntity).findOne({ where: { id } });
      if (!located) throw new NotFoundException('수동 원장 제안을 찾을 수 없습니다.');
      await this.lockOrderDelivery(located.orderDeliveryId, manager);
      const inbox = await this.lockInbox(located.inboxRowId, manager);
      const proposal = await manager
        .getRepository(PartnerProviderManualLedgerProposalEntity)
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.id = :id', { id })
        .getOne();
      if (!proposal) throw new NotFoundException('수동 원장 제안을 찾을 수 없습니다.');
      if (proposal.orderDeliveryId !== located.orderDeliveryId || proposal.inboxRowId !== located.inboxRowId) {
        throw new ConflictException('수동 원장 제안 범위가 동시에 변경되었습니다.');
      }
      if (proposal.status === decision) {
        if (proposal.status === 'APPROVED') {
          const terminal = proposal.resolutionMode === 'LEDGER' ? 'ORPHAN_LEDGERED' : 'ORPHAN_DISCARDED';
          if (
            inbox.provider !== proposal.provider ||
            inbox.origin !== 'ORPHAN' ||
            inbox.processedStatus !== terminal ||
            inbox.manualLedgerProposalId !== proposal.id
          ) {
            throw new ConflictException('승인된 orphan 제안의 inbox 상태가 일치하지 않습니다.');
          }
        }
        return { proposal, ledgerIds: await this.ledgerIds(proposal, manager) };
      }
      if (proposal.status !== 'PENDING') throw new ConflictException('이미 반대 결정으로 종결되었습니다.');
      if (proposal.proposedBy === actorId) throw new ForbiddenException('제안자는 자신의 제안을 결정할 수 없습니다.');
      this.assertInbox(inbox, proposal.provider);
      const context = await this.settlementContext(inbox, manager);
      const sourceType = resolveSourceType(context.settleMethod!);
      if (proposal.sourceType !== inbox.sourceType || proposal.sourceType !== sourceType)
        throw new BadRequestException('수동 원장 제안 sourceType이 발송 상품 정산방식과 일치하지 않습니다.');
      const decidedAt = new Date();
      if (decision === 'REJECTED') {
        const changed = await manager
          .getRepository(PartnerProviderManualLedgerProposalEntity)
          .update({ id, status: 'PENDING' }, { status: 'REJECTED', decidedBy: actorId, decidedAt, decisionReason });
        if (changed.affected !== 1) throw new ConflictException('제안 상태가 동시에 변경되었습니다.');
        return {
          proposal: { ...proposal, status: 'REJECTED', decidedBy: actorId, decidedAt, decisionReason },
          ledgerIds: [],
        };
      }
      const ledgerIds: number[] = [];
      if (proposal.resolutionMode === 'LEDGER') ledgerIds.push(...(await this.appendLedgers(proposal, inbox, manager)));
      const terminal = proposal.resolutionMode === 'LEDGER' ? 'ORPHAN_LEDGERED' : 'ORPHAN_DISCARDED';
      const claimed = await manager
        .getRepository(PartnerProviderEventInboxEntity)
        .update(
          { id: inbox.id, processedStatus: 'ORPHAN_PENDING' },
          { processedStatus: terminal as any, manualLedgerProposalId: proposal.id },
        );
      if (claimed.affected !== 1) throw new ConflictException('orphan inbox 상태가 동시에 변경되었습니다.');
      await manager.getRepository(PartnerSettleReviewAuditEntity).insert({
        ledgerId: null,
        manualLedgerProposalId: proposal.id,
        beforeStatus: null,
        afterStatus: terminal,
        beforeReviewCode: null,
        afterReviewCode: null,
        beforeReviewResolution: null,
        afterReviewResolution: null,
        beforeOccurredAt: null,
        afterOccurredAt: null,
        beforeBaseAmount: null,
        afterBaseAmount: null,
        beforeAppliedPricePercent: null,
        afterAppliedPricePercent: null,
        beforeAppliedPriceAdjustment: null,
        afterAppliedPriceAdjustment: null,
        beforeSettleAmount: null,
        afterSettleAmount: null,
        beforePricingResolution: null,
        afterPricingResolution: null,
        providerEvidenceRef: proposal.evidenceRef,
        providerEvidenceHash: proposal.evidenceHash,
        priceEvidenceRef: null,
        resolutionId: null,
        actorId,
        reason: proposal.reason,
        createdAt: decidedAt,
      });
      const changed = await manager
        .getRepository(PartnerProviderManualLedgerProposalEntity)
        .update({ id, status: 'PENDING' }, { status: 'APPROVED', decidedBy: actorId, decidedAt, decisionReason });
      if (changed.affected !== 1) throw new ConflictException('제안 상태가 동시에 변경되었습니다.');
      return {
        proposal: { ...proposal, status: 'APPROVED', decidedBy: actorId, decidedAt, decisionReason },
        ledgerIds,
      };
    });
  }

  private async appendLedgers(
    proposal: PartnerProviderManualLedgerProposalEntity,
    inbox: PartnerProviderEventInboxEntity,
    manager: EntityManager,
  ): Promise<number[]> {
    const facts = proposal.proposedLedgerFacts!;
    const base = BigInt(facts.baseAmount as string);
    const occurredAt = parseKstDateTime(facts.occurredAt as string);
    const context = await this.settlementContext(inbox, manager);
    this.validateProposedFacts(facts, inbox, context);
    const subItem = {
      provider: proposal.provider as IPartnerCompanyType,
      ...context.subItem,
      giftKind: typeof facts.giftKind === 'string' ? facts.giftKind : context.subItem.giftKind,
      brandCode: typeof facts.brandCode === 'string' ? facts.brandCode : context.subItem.brandCode,
    };
    const subItemKey = resolveSubItemKey(subItem);
    if (facts.subItemKey !== undefined && facts.subItemKey !== subItemKey)
      throw new BadRequestException('subItemKey는 서버 하위항목 판정과 일치해야 합니다.');
    if (base > 0n) {
      if (facts.reversesLedgerId !== undefined)
        throw new BadRequestException('양수 원장은 reversesLedgerId를 지정할 수 없습니다.');
      const ledger = await this.ledgerService.appendLedger(
        {
          partnerCompanyId: context.partnerCompanyId,
          subItem,
          sourceType: proposal.sourceType,
          orderDeliveryId: inbox.orderDeliveryId,
          idempotencyKey: `MANUAL_LEDGER:${proposal.id}`,
          occurredAt,
          baseAmount: base,
          vatCalculationMode: 'NONE',
          snapshot: context.snapshot,
          providerEvidenceRef: proposal.evidenceRef,
          providerEvidenceHash: proposal.evidenceHash,
          orphanInboxRowId: inbox.id,
          manualLedgerProposalId: proposal.id,
          memo: proposal.reason,
        },
        manager,
      );
      return [ledger.id];
    }

    const requested = -base;
    const designated = facts.reversesLedgerId;
    const originals =
      designated === undefined
        ? await manager
            .getRepository(PartnerSettleLedgerEntity)
            .find({ where: { orderDeliveryId: inbox.orderDeliveryId }, order: { id: 'DESC' } })
        : [await manager.getRepository(PartnerSettleLedgerEntity).findOne({ where: { id: Number(designated) } })];
    let remaining = requested;
    const ledgerIds: number[] = [];
    for (const original of originals) {
      if (
        !original ||
        original.partnerCompanyId !== context.partnerCompanyId ||
        original.orderDeliveryId !== inbox.orderDeliveryId ||
        original.sourceType !== proposal.sourceType ||
        original.reversesLedgerId !== null ||
        original.status === 'NEEDS_REVIEW' ||
        original.baseAmount === null ||
        BigInt(original.baseAmount) <= 0n
      ) {
        if (designated !== undefined)
          throw new BadRequestException('지정한 원본 원장은 같은 발송건·협력사의 취소 가능한 양수 원장이 아닙니다.');
        continue;
      }
      const prior = await manager
        .getRepository(PartnerSettleLedgerEntity)
        .find({ where: { reversesLedgerId: original.id } });
      const capacity = BigInt(original.baseAmount!) + prior.reduce((sum, row) => sum + BigInt(row.baseAmount!), 0n);
      if (capacity <= 0n) continue;
      const allocation = remaining < capacity ? remaining : capacity;
      const reversal = await this.ledgerService.appendReversal(
        {
          reversesLedgerId: original.id,
          baseIdempotencyKey: `MANUAL_LEDGER:${proposal.id}`,
          occurredAt,
          cancelBaseAmount: allocation,
          providerEvidenceRef: proposal.evidenceRef,
          providerEvidenceHash: proposal.evidenceHash,
          memo: proposal.reason,
          manualLedgerProposalId: proposal.id,
        },
        manager,
      );
      ledgerIds.push(reversal.id);
      remaining -= allocation;
      if (remaining === 0n) return ledgerIds;
    }
    throw new UnprocessableEntityException('취소 금액이 원본 원장 잔여금액을 초과합니다.');
  }
  /**
   * proposedLedgerFacts의 baseAmount·부호를 inbox 증적(USAGE) 또는 상품 snapshot(ISSUANCE/EXCHANGE)과 대조한다.
   * giftKind도 inbox 증적과 교차 검증한다. 불일치 시 400/422.
   */
  private validateProposedFacts(
    facts: Record<string, unknown>,
    inbox: PartnerProviderEventInboxEntity,
    context: SettlementContext,
  ): void {
    const base = BigInt(facts.baseAmount as string);
    const payload = inbox.normalizedPayload;

    if (inbox.sourceType === 'USAGE') {
      // USAGE: 금액은 inbox 증적 amount 에서 도출, 부호는 appDiv 에서 도출
      const evidenceAmount = payload?.amount;
      if (typeof evidenceAmount !== 'string' && typeof evidenceAmount !== 'number') {
        throw new BadRequestException('orphan inbox 증적에 amount가 없습니다.');
      }
      const expected = BigInt(evidenceAmount);
      if (expected <= 0n) throw new BadRequestException('orphan inbox 증적의 amount가 양수가 아닙니다.');

      const appDiv = payload?.appDiv;
      if (typeof appDiv === 'string') {
        if (GALAXIA_FORWARD_APP_DIVS.has(appDiv)) {
          if (base !== expected)
            throw new UnprocessableEntityException(
              `USAGE baseAmount(${base})는 inbox 증적 amount(${expected})와 일치해야 합니다 (appDiv=${appDiv}).`,
            );
        } else if (GALAXIA_REVERSAL_APP_DIVS.has(appDiv)) {
          if (base !== -expected)
            throw new UnprocessableEntityException(
              `USAGE 취소 baseAmount(${base})는 inbox 증적 amount의 음수(-${expected})여야 합니다 (appDiv=${appDiv}).`,
            );
        } else {
          throw new BadRequestException(`인식되지 않는 appDiv입니다: ${appDiv}`);
        }
      } else {
        // appDiv 없는 USAGE — 절대값만 대조
        const absBase = base < 0n ? -base : base;
        if (absBase !== expected)
          throw new UnprocessableEntityException(
            `baseAmount 절대값(${absBase})은 inbox 증적 amount(${expected})와 일치해야 합니다.`,
          );
      }
    } else {
      // ISSUANCE / EXCHANGE: 금액은 불변 상품 snapshot 정가에서 도출, 부호는 provider 증적에서 도출
      const snapshotPrice = context.snapshot.price;
      if (snapshotPrice === null || snapshotPrice === undefined)
        throw new BadRequestException('상품 스냅샷에서 정가를 찾을 수 없습니다.');
      const expected = BigInt(snapshotPrice);
      if (expected <= 0n) throw new BadRequestException('상품 스냅샷 정가가 양수가 아닙니다.');

      const appDiv = payload?.appDiv;
      const pinStatusCd = payload?.pinStatusCd;

      if (typeof appDiv === 'string') {
        // Galaxia: appDiv로 부호 결정 (USAGE와 동일 기준)
        if (GALAXIA_FORWARD_APP_DIVS.has(appDiv)) {
          if (base !== expected)
            throw new UnprocessableEntityException(
              `ISSUANCE/EXCHANGE baseAmount(${base})는 스냅샷 정가(${expected})여야 합니다 (appDiv=${appDiv}).`,
            );
        } else if (GALAXIA_REVERSAL_APP_DIVS.has(appDiv)) {
          if (base !== -expected)
            throw new UnprocessableEntityException(
              `ISSUANCE/EXCHANGE 취소 baseAmount(${base})는 스냅샷 정가의 음수(-${expected})여야 합니다 (appDiv=${appDiv}).`,
            );
        } else {
          throw new BadRequestException(`인식되지 않는 appDiv입니다: ${appDiv}`);
        }
      } else if (typeof pinStatusCd === 'string') {
        // GiftShow: pinStatusCd로 부호 결정
        if (GIFTSHOW_FORWARD_PIN_STATUS.has(pinStatusCd)) {
          if (base !== expected)
            throw new UnprocessableEntityException(
              `ISSUANCE/EXCHANGE baseAmount(${base})는 스냅샷 정가(${expected})여야 합니다 (pinStatusCd=${pinStatusCd}).`,
            );
        } else if (GIFTSHOW_REVERSAL_PIN_STATUS.has(pinStatusCd)) {
          if (base !== -expected)
            throw new UnprocessableEntityException(
              `ISSUANCE/EXCHANGE 취소 baseAmount(${base})는 스냅샷 정가의 음수(-${expected})여야 합니다 (pinStatusCd=${pinStatusCd}).`,
            );
        } else {
          throw new BadRequestException(`부호를 도출할 수 없는 pinStatusCd입니다: ${pinStatusCd}`);
        }
      } else {
        throw new BadRequestException(
          'ISSUANCE/EXCHANGE 증적에 부호를 도출할 수 있는 provider 상태(appDiv 또는 pinStatusCd)가 없습니다.',
        );
      }
    }

    // giftKind 교차 검증 — inbox 증적과 proposedLedgerFacts 불일치 금지
    if (typeof facts.giftKind === 'string' && typeof payload?.giftKind === 'string') {
      if (facts.giftKind !== payload.giftKind)
        throw new BadRequestException(
          `giftKind(${facts.giftKind})가 inbox 증적(${payload.giftKind})과 일치하지 않습니다.`,
        );
    }
  }

  private async settlementContext(inbox: PartnerProviderEventInboxEntity, manager: EntityManager) {
    const delivery = await manager.getRepository(OrderDeliveryEntity).findOne({
      where: { id: inbox.orderDeliveryId },
      relations: [
        'orderProductMapping',
        'orderProductMapping.product',
        'orderProductMapping.product.partnerCompany',
        'choiceSelectProduct',
        'choiceSelectProduct.partnerCompany',
      ],
    });
    if (!delivery) throw new BadRequestException('발송건을 찾을 수 없습니다.');
    const context = buildSettlementContext(delivery, inbox.provider as IPartnerCompanyType);
    if (!context || !context.partnerCompanyId || !context.settleMethod)
      throw new BadRequestException('발송건의 협력사 정산 스냅샷을 찾을 수 없습니다.');
    return context;
  }
  private async ledgerIds(p: PartnerProviderManualLedgerProposalEntity, m: EntityManager) {
    if (p.resolutionMode === 'DISCARD') return [];
    const rows = await m
      .getRepository(PartnerSettleLedgerEntity)
      .find({ where: { manualLedgerProposalId: p.id }, order: { id: 'ASC' } });
    return rows.map((x) => x.id);
  }
  private async lockInbox(id: number, m: EntityManager) {
    const row = await m
      .getRepository(PartnerProviderEventInboxEntity)
      .createQueryBuilder('i')
      .setLock('pessimistic_write')
      .where('i.id = :id', { id })
      .getOne();
    if (!row) throw new BadRequestException('orphan inbox를 찾을 수 없습니다.');
    return row;
  }
  private async lockOrderDelivery(id: number, m: EntityManager): Promise<void> {
    const rows = await m.query('SELECT id FROM order_delivery WHERE id = ? FOR UPDATE', [id]);
    if (!rows?.length) throw new BadRequestException('발송건을 찾을 수 없습니다.');
  }
  private assertInbox(i: PartnerProviderEventInboxEntity, provider: string) {
    if (i.provider !== provider || i.origin !== 'ORPHAN')
      throw new BadRequestException('orphan inbox 범위가 올바르지 않습니다.');
    if (i.processedStatus !== 'ORPHAN_PENDING') throw new ConflictException('이미 종결된 orphan inbox입니다.');
  }
  private normalize(c: Propose) {
    const resolutionMode = c.resolutionMode ?? 'LEDGER';
    if (!['LEDGER', 'DISCARD'].includes(resolutionMode))
      throw new BadRequestException('resolutionMode이 올바르지 않습니다.');
    if (!Number.isInteger(c.inboxRowId) || c.inboxRowId <= 0)
      throw new BadRequestException('inboxRowId가 올바르지 않습니다.');
    const facts = c.proposedLedgerFacts ?? null;
    if ((resolutionMode === 'LEDGER') !== (facts !== null))
      throw new BadRequestException('resolutionMode과 proposedLedgerFacts가 일치하지 않습니다.');
    if (facts) {
      if (typeof facts.baseAmount !== 'string' || !/^-?[1-9]\d*$/.test(facts.baseAmount) || facts.baseAmount === '0')
        throw new BadRequestException('baseAmount는 0이 아닌 canonical 정수 문자열이어야 합니다.');
      if (facts.giftKind !== undefined && typeof facts.giftKind !== 'string')
        throw new BadRequestException('giftKind가 올바르지 않습니다.');
      if (facts.brandCode !== undefined && typeof facts.brandCode !== 'string')
        throw new BadRequestException('brandCode가 올바르지 않습니다.');
      if (facts.subItemKey !== undefined && (typeof facts.subItemKey !== 'string' || !facts.subItemKey.trim()))
        throw new BadRequestException('subItemKey가 올바르지 않습니다.');
      try {
        parseKstDateTime(String(facts.occurredAt));
      } catch (e) {
        if (e instanceof SettleTimeParseError) throw new BadRequestException(e.message);
        throw e;
      }
    }
    const requestKey = this.text(c.requestKey, 'requestKey', 128);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestKey))
      throw new BadRequestException('requestKey는 영문, 숫자, 밑줄, 하이픈만 사용할 수 있습니다.');
    return {
      ...c,
      resolutionMode,
      proposedLedgerFacts: facts,
      provider: this.text(c.provider, 'provider', 24),
      evidenceRef: this.text(c.evidenceRef, 'evidenceRef', 1000),
      reason: this.text(c.reason, 'reason', 500),
      requestKey,
    };
  }
  private hash(c: any, i: PartnerProviderEventInboxEntity) {
    return computePayloadHash(
      {
        provider: i.provider,
        inboxRowId: i.id,
        resolutionMode: c.resolutionMode,
        proposedLedgerFacts: c.proposedLedgerFacts,
        evidenceRef: c.evidenceRef,
        reason: c.reason,
        requestKey: c.requestKey,
      },
      VERSION,
    );
  }
  private replay(p: PartnerProviderManualLedgerProposalEntity, c: any) {
    if (
      p.payloadHashVersion !== VERSION ||
      p.payloadHash !==
        computePayloadHash(
          {
            provider: c.provider,
            inboxRowId: c.inboxRowId,
            resolutionMode: c.resolutionMode,
            proposedLedgerFacts: c.proposedLedgerFacts,
            evidenceRef: c.evidenceRef,
            reason: c.reason,
            requestKey: c.requestKey,
          },
          VERSION,
        )
    )
      throw new ConflictException('같은 requestKey에 다른 요청 payload가 이미 등록되었습니다.');
    return { proposal: p, ledgerIds: [] };
  }
  private text(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string') throw new BadRequestException(`${field}가 올바르지 않습니다.`);
    const normalized = value.normalize('NFC').trim();
    if (!normalized || normalized.length > max || /[\u0000-\u001F\u007F-\u009F]/u.test(normalized))
      throw new BadRequestException(`${field}가 올바르지 않습니다.`);
    return normalized;
  }
  private optionalText(value: unknown, field: string, max: number): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') throw new BadRequestException(`${field}가 올바르지 않습니다.`);
    const normalized = value.normalize('NFC').trim();
    if (!normalized) return null;
    if (/[\u0000-\u001F\u007F-\u009F]/u.test(normalized))
      throw new BadRequestException(`${field}가 올바르지 않습니다.`);
    if (normalized.length > max) throw new BadRequestException(`${field}가 올바르지 않습니다.`);
    return normalized;
  }
}
