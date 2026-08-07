import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerProviderEventInboxEntity } from '../../entity/partner.provider.event.inbox.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerSettleTransitionResolutionEntity } from '../../entity/partner.settle.transition.resolution.entity';
import { PartnerSettleTransitionObservationEntity } from '../../entity/partner.settle.transition.observation.entity';
import { buildSettlementContext } from './partner.settle.context.builder';
import { PartnerSettleLedgerService } from './partner.settle.ledger.service';
import { computeEvidenceHash, computePayloadHash } from '../domain/proposal.hash';
import { buildManualResolutionKey, buildProviderTransitionKey } from '../domain/settle.idempotency.key';
import { resolveSubItemKey } from '../domain/settle.sub.item.key';
import { parseKstDateTime, SettleTimeParseError, toDbDateTimeString } from '../domain/settle.time';
import { isDuplicateKeyError } from './partner.settle.raw.insert';

const HASH_VERSION = 'v2';
type Origin = 'PROVIDER' | 'MANUAL';
type ForwardFacts = { action: 'FORWARD'; baseAmount: string; subItemKey: string };
type ReversalFacts = { action: 'REVERSAL'; allocations: { reversesLedgerId: number; cancelBaseAmount: string }[] };
type Transition = {
  prevStatus: string;
  newStatus: string;
  sourceEventIdOrigin: Origin;
  sourceEventId: string | null;
  providerEvidenceRef: string;
  providerEvidenceHash: string;
  sourceOccurredAt: string;
  occurredAt: string;
  ledgerFacts: ForwardFacts | ReversalFacts;
};
type Propose = { transitions: any[]; reason?: string | null; requestKey: string };

@Injectable()
export class PartnerSettleTransitionResolutionService {
  constructor(
    @InjectRepository(PartnerSettleTransitionResolutionEntity)
    private readonly resolutionRepository: Repository<PartnerSettleTransitionResolutionEntity>,
    @InjectRepository(PartnerSettleTransitionObservationEntity)
    private readonly observationRepository: Repository<PartnerSettleTransitionObservationEntity>,
    private readonly dataSource: DataSource,
    private readonly ledgerService: PartnerSettleLedgerService,
  ) {}

  async propose(observationId: number, command: Propose, actorId: number) {
    const normalized = this.normalize(command);
    const existing = await this.resolutionRepository.findOne({ where: { requestKey: normalized.requestKey } });
    if (existing) return this.replay(existing, normalized, observationId);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const raced = await manager
          .getRepository(PartnerSettleTransitionResolutionEntity)
          .findOne({ where: { requestKey: normalized.requestKey } });
        if (raced) return this.replay(raced, normalized, observationId);
        const observation = await this.lockObservation(observationId, manager);
        if (observation.resolutionStatus !== 'UNRESOLVED') throw new ConflictException('해소 대상이 아닌 관측입니다.');
        this.validateChain(observation, normalized.transitions);
        const proposal = manager.getRepository(PartnerSettleTransitionResolutionEntity).create({
          observationId,
          proposedTransitions: normalized.transitions,
          resolutionBundleHash: this.bundleHash(normalized.transitions),
          requestKey: normalized.requestKey,
          payloadHash: this.payloadHash(observationId, normalized),
          payloadHashVersion: HASH_VERSION,
          status: 'PENDING',
          proposedBy: actorId,
          decidedBy: null,
          decidedAt: null,
          decisionReason: normalized.reason,
        });
        const saved = await manager.getRepository(PartnerSettleTransitionResolutionEntity).save(proposal);
        const updated = await manager
          .getRepository(PartnerSettleTransitionObservationEntity)
          .update({ id: observation.id, resolutionStatus: 'UNRESOLVED' }, { resolutionProposedBy: actorId });
        if (updated.affected !== 1) throw new ConflictException('관측 상태가 동시에 변경되었습니다.');
        return { proposal: saved, ledgerIds: [] };
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.resolutionRepository.findOne({ where: { requestKey: normalized.requestKey } });
      if (raced) return this.replay(raced, normalized, observationId);
      throw new ConflictException('해당 관측에 이미 활성 해소 제안이 있습니다.');
    }
  }

  async approve(proposalId: number, actorId: number, decisionReason?: string | null) {
    return this.dataSource.transaction(async (manager) => {
      const initial = await manager
        .getRepository(PartnerSettleTransitionResolutionEntity)
        .findOne({ where: { id: proposalId } });
      if (!initial) throw new NotFoundException('전이 해소 제안을 찾을 수 없습니다.');
      const initialObservation = await manager
        .getRepository(PartnerSettleTransitionObservationEntity)
        .findOne({ where: { id: initial.observationId } });
      if (!initialObservation) throw new NotFoundException('전이 관측을 찾을 수 없습니다.');
      const context = await this.loadContext(initialObservation, manager);
      await this.ledgerService.lockForAppend(context.partnerCompanyId, context.orderDeliveryId, manager);
      const observation = await this.lockObservation(initial.observationId, manager);
      const proposal = await this.lockProposal(proposalId, manager);
      if (proposal.status === 'APPROVED')
        return { proposal, ledgerIds: await this.approvedLedgerIds(proposal, manager) };
      if (proposal.status === 'REJECTED') throw new ConflictException('이미 반려된 전이 해소 제안입니다.');
      if (proposal.proposedBy === actorId) throw new ForbiddenException('제안자는 자신의 제안을 승인할 수 없습니다.');
      if (proposal.observationId !== observation.id || observation.resolutionStatus !== 'UNRESOLVED')
        throw new ConflictException('관측이 이미 해소되었습니다.');
      const transitions = proposal.proposedTransitions as Transition[];
      this.validateChain(observation, transitions);
      const ledgerIds: number[] = [];
      for (let index = 0; index < transitions.length; index++) {
        const transition = transitions[index];
        const evidence = await this.lockEvidence(observation, manager);
        this.validateAccounting(observation, context, transition, evidence);
        const transitionRef = {
          observationId: observation.id,
          sequenceNo: index + 1,
          allocationNo: 1,
          sourceEventIdOrigin: transition.sourceEventIdOrigin,
        } as const;
        const baseKey =
          transition.sourceEventIdOrigin === 'PROVIDER'
            ? buildProviderTransitionKey(observation.provider, observation.sourceType, transition.sourceEventId!)
            : buildManualResolutionKey(proposal.id, index + 1);
        const facts = transition.ledgerFacts;
        if (facts.action === 'FORWARD') {
          const ledger = await this.ledgerService.appendLedger(
            {
              partnerCompanyId: context.partnerCompanyId,
              subItem: this.subItemFor(observation, context, evidence),
              sourceType: observation.sourceType,
              orderDeliveryId: observation.orderDeliveryId,
              idempotencyKey: baseKey,
              occurredAt: parseKstDateTime(transition.occurredAt),
              baseAmount: BigInt(facts.baseAmount),
              vatCalculationMode: 'NONE',
              snapshot: context.snapshot,
              providerEvidenceRef: transition.providerEvidenceRef,
              providerEvidenceHash: transition.providerEvidenceHash,
              transition: transitionRef,
            },
            manager,
          );
          ledgerIds.push(ledger.id);
        } else
          for (let allocationNo = 0; allocationNo < facts.allocations.length; allocationNo++) {
            const allocation = facts.allocations[allocationNo];
            await this.assertReversalScope(allocation.reversesLedgerId, observation, context.partnerCompanyId, manager);
            const ledger = await this.ledgerService.appendReversal(
              {
                reversesLedgerId: allocation.reversesLedgerId,
                baseIdempotencyKey: baseKey,
                occurredAt: parseKstDateTime(transition.occurredAt),
                cancelBaseAmount: BigInt(allocation.cancelBaseAmount),
                providerEvidenceRef: transition.providerEvidenceRef,
                providerEvidenceHash: transition.providerEvidenceHash,
                transition: { ...transitionRef, allocationNo: allocationNo + 1 },
              },
              manager,
            );
            ledgerIds.push(ledger.id);
          }
      }
      if (!ledgerIds.length) throw new ConflictException('승인할 원장이 없습니다.');
      const decidedAt = new Date();
      const reason = this.optionalText(decisionReason, 1000);
      const changed = await manager
        .getRepository(PartnerSettleTransitionResolutionEntity)
        .update(
          { id: proposal.id, status: 'PENDING' },
          { status: 'APPROVED', decidedBy: actorId, decidedAt, decisionReason: reason },
        );
      if (changed.affected !== 1) throw new ConflictException('전이 해소 제안 상태가 동시에 변경되었습니다.');
      const observed = await manager.getRepository(PartnerSettleTransitionObservationEntity).update(
        { id: observation.id, resolutionStatus: 'UNRESOLVED' },
        {
          resolutionStatus: 'RESOLVED',
          resolutionApprovedBy: actorId,
          resolvedAt: decidedAt,
          resolutionBundleHash: proposal.resolutionBundleHash,
        },
      );
      if (observed.affected !== 1) throw new ConflictException('관측 상태가 동시에 변경되었습니다.');
      return {
        proposal: { ...proposal, status: 'APPROVED' as const, decidedBy: actorId, decidedAt, decisionReason: reason },
        ledgerIds,
      };
    });
  }

  async reject(proposalId: number, actorId: number, decisionReason?: string | null) {
    const reason = this.requiredText(decisionReason, 'decisionReason', 1000);
    return this.dataSource.transaction(async (manager) => {
      const proposal = await this.lockProposal(proposalId, manager);
      if (proposal.status === 'REJECTED') return { proposal, ledgerIds: [] };
      if (proposal.status === 'APPROVED') throw new ConflictException('이미 승인된 전이 해소 제안입니다.');
      if (proposal.proposedBy === actorId) throw new ForbiddenException('제안자는 자신의 제안을 반려할 수 없습니다.');
      const changed = await manager
        .getRepository(PartnerSettleTransitionResolutionEntity)
        .update(
          { id: proposal.id, status: 'PENDING' },
          { status: 'REJECTED', decidedBy: actorId, decidedAt: new Date(), decisionReason: reason },
        );
      if (changed.affected !== 1) throw new ConflictException('전이 해소 제안 상태가 동시에 변경되었습니다.');
      return {
        proposal: { ...proposal, status: 'REJECTED' as const, decidedBy: actorId, decisionReason: reason },
        ledgerIds: [],
      };
    });
  }

  private async loadContext(observation: PartnerSettleTransitionObservationEntity, manager: EntityManager) {
    const delivery = await manager.getRepository(OrderDeliveryEntity).findOne({
      where: { id: observation.orderDeliveryId },
      relations: [
        'orderProductMapping',
        'orderProductMapping.product',
        'choiceSelectProduct',
        'choiceSelectProduct.partnerCompany',
        'orderProductMapping.product.partnerCompany',
      ],
    });
    if (!delivery) throw new NotFoundException('발송건을 찾을 수 없습니다.');
    const context = buildSettlementContext(delivery, observation.provider);
    if (!context || !context.partnerCompanyId || !context.settleMethod)
      throw new BadRequestException('불변 정산 스냅샷을 도출할 수 없습니다.');
    const expected =
      context.settleMethod === 'PER_ISSUANCE'
        ? 'ISSUANCE'
        : context.settleMethod === 'PER_EXCHANGE'
          ? 'EXCHANGE'
          : context.settleMethod === 'PER_PRODUCT'
            ? 'USAGE'
            : null;
    if (expected !== observation.sourceType)
      throw new BadRequestException('상품 정산 방식과 sourceType이 일치하지 않습니다.');
    return context;
  }

  private async lockEvidence(observation: PartnerSettleTransitionObservationEntity, manager: EntityManager) {
    const match = /^INBOX:(\d+)$/.exec(observation.unresolvedEvidenceKey ?? '');
    if (!match) return null;
    const inbox = await manager
      .getRepository(PartnerProviderEventInboxEntity)
      .findOne({ where: { id: Number(match[1]) }, lock: { mode: 'pessimistic_write' } });
    if (
      !inbox ||
      inbox.observationId !== observation.id ||
      inbox.orderDeliveryId !== observation.orderDeliveryId ||
      inbox.provider !== observation.provider ||
      inbox.sourceType !== observation.sourceType ||
      inbox.processedStatus !== 'LINKED'
    )
      throw new BadRequestException('연결된 INBOX 증적이 올바르지 않습니다.');
    return inbox;
  }

  private validateAccounting(
    observation: PartnerSettleTransitionObservationEntity,
    context: NonNullable<ReturnType<typeof buildSettlementContext>>,
    transition: Transition,
    inbox: PartnerProviderEventInboxEntity | null,
  ) {
    const forward = transition.ledgerFacts.action === 'FORWARD';
    const code = transition.newStatus;
    const forwardCodes: Record<string, string[]> = {
      SSG: ['0400'],
      GIFT_SHOW: ['02'],
      DAOU: ['01', '03'],
      GIFTIEL: ['L1'],
      GALAXIA: ['10'],
    };
    const reverseCodes: Record<string, string[]> = {
      GIFT_SHOW: ['07'],
      DAOU: ['02'],
      GIFTIEL: ['L2'],
      GALAXIA: ['20', '25', '81'],
    };
    if (transition.prevStatus === transition.newStatus)
      throw new BadRequestException('상태 변화 없는 전이는 허용되지 않습니다.');
    if (observation.sourceType === 'ISSUANCE' && forward)
      throw new BadRequestException('ISSUANCE는 취소/환불 취소만 가능합니다.');
    if (observation.sourceType === 'ISSUANCE' && !/CANCEL|REFUND_CANCEL/i.test(code))
      throw new BadRequestException('ISSUANCE 역분개 상태가 올바르지 않습니다.');
    if (observation.sourceType === 'USAGE' && observation.provider !== 'GALAXIA')
      throw new BadRequestException('USAGE provider가 올바르지 않습니다.');
    if (
      observation.sourceType !== 'ISSUANCE' &&
      !(forward ? forwardCodes[observation.provider] : reverseCodes[observation.provider])?.includes(code)
    )
      throw new BadRequestException('provider 상태 코드와 회계 action이 일치하지 않습니다.');
    const facts = transition.ledgerFacts;
    if (facts.action === 'FORWARD') {
      const amount = observation.sourceType === 'USAGE' ? inbox?.normalizedPayload?.amount : context.snapshot.price;
      if (typeof amount !== 'string' && typeof amount !== 'number')
        throw new BadRequestException('FORWARD 금액 근거를 도출할 수 없습니다.');
      if (BigInt(facts.baseAmount) !== BigInt(amount))
        throw new BadRequestException('FORWARD 금액이 불변 근거와 일치하지 않습니다.');
      const derived = resolveSubItemKey(this.subItemFor(observation, context, inbox));
      if (derived !== facts.subItemKey)
        throw new BadRequestException('subItemKey가 불변 스냅샷/증적 판정과 일치하지 않습니다.');
    } else {
      if (!inbox) throw new BadRequestException('REVERSAL은 연결된 INBOX 증적이 필요합니다.');
      const amount = inbox.normalizedPayload?.amount;
      if (
        typeof amount !== 'string' ||
        !/^[1-9]\d*$/.test(amount) ||
        BigInt(amount) !==
          facts.allocations.reduce(
            (sum: bigint, item: { cancelBaseAmount: string }) => sum + BigInt(item.cancelBaseAmount),
            0n,
          )
      )
        throw new BadRequestException('INBOX amount와 역분개 배분 금액이 일치하지 않습니다.');
    }
  }
  private subItemFor(
    observation: PartnerSettleTransitionObservationEntity,
    context: NonNullable<ReturnType<typeof buildSettlementContext>>,
    inbox: PartnerProviderEventInboxEntity | null,
  ) {
    if (observation.provider !== 'GALAXIA') return { provider: observation.provider, ...context.subItem };
    if (!inbox) throw new BadRequestException('갤럭시아 하위항목에는 연결된 INBOX 증적이 필요합니다.');
    const payload = inbox.normalizedPayload;
    return {
      provider: observation.provider,
      giftKind: typeof payload.giftKind === 'string' ? payload.giftKind : null,
      brandCode: typeof payload.brandCode === 'string' ? payload.brandCode : null,
    };
  }

  private async assertReversalScope(
    id: number,
    observation: PartnerSettleTransitionObservationEntity,
    partnerCompanyId: number,
    manager: EntityManager,
  ) {
    const original = await manager
      .getRepository(PartnerSettleLedgerEntity)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (
      !original ||
      original.orderDeliveryId !== observation.orderDeliveryId ||
      original.partnerCompanyId !== partnerCompanyId ||
      original.sourceType !== observation.sourceType ||
      original.reversesLedgerId !== null
    )
      throw new BadRequestException('역분개 원장 범위가 올바르지 않습니다.');
  }
  private async approvedLedgerIds(proposal: PartnerSettleTransitionResolutionEntity, manager: EntityManager) {
    const transitions = proposal.proposedTransitions as Transition[];
    const rows = await manager.getRepository(PartnerSettleLedgerEntity).find({
      where: { transitionObservationId: proposal.observationId },
      order: { transitionSequenceNo: 'ASC', transitionAllocationNo: 'ASC', id: 'ASC' },
    });
    const expected = transitions.flatMap((transition, index) =>
      Array.from(
        { length: transition.ledgerFacts.action === 'FORWARD' ? 1 : transition.ledgerFacts.allocations.length },
        (_, allocation) => ({
          sequenceNo: index + 1,
          allocationNo: allocation + 1,
          origin: transition.sourceEventIdOrigin,
        }),
      ),
    );
    if (
      rows.length !== expected.length ||
      rows.some(
        (row, index) =>
          row.transitionSequenceNo !== expected[index].sequenceNo ||
          row.transitionAllocationNo !== expected[index].allocationNo ||
          row.sourceEventIdOrigin !== expected[index].origin,
      )
    )
      throw new ConflictException('승인된 제안의 원장 구성이 일치하지 않습니다.');
    return rows.map((row) => row.id);
  }
  private async lockProposal(id: number, manager: EntityManager) {
    const proposal = await manager
      .getRepository(PartnerSettleTransitionResolutionEntity)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!proposal) throw new NotFoundException('전이 해소 제안을 찾을 수 없습니다.');
    return proposal;
  }
  private async lockObservation(id: number, manager: EntityManager) {
    const observation = await manager
      .getRepository(PartnerSettleTransitionObservationEntity)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!observation) throw new NotFoundException('전이 관측을 찾을 수 없습니다.');
    return observation;
  }
  private replay(
    existing: PartnerSettleTransitionResolutionEntity,
    command: ReturnType<PartnerSettleTransitionResolutionService['normalize']>,
    observationId: number,
  ) {
    if (
      existing.observationId !== observationId ||
      existing.payloadHashVersion !== HASH_VERSION ||
      existing.payloadHash !== this.payloadHash(observationId, command)
    )
      throw new ConflictException('requestKey가 다른 요청에 이미 사용되었습니다.');
    return { proposal: existing, ledgerIds: [] };
  }
  private normalize(command: Propose) {
    const requestKey = this.requiredText(command.requestKey, 'requestKey', 128);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestKey))
      throw new BadRequestException('requestKey 형식이 올바르지 않습니다.');
    if (!Array.isArray(command.transitions) || !command.transitions.length)
      throw new BadRequestException('전이는 한 건 이상 필요합니다.');
    const transitions = command.transitions.map((item) => {
      const origin = item.sourceEventIdOrigin;
      const sourceEventId = this.optionalText(item.sourceEventId, 255);
      if (
        !['PROVIDER', 'MANUAL'].includes(origin) ||
        (origin === 'PROVIDER' && !sourceEventId) ||
        (origin === 'MANUAL' && sourceEventId)
      )
        throw new BadRequestException('sourceEventId origin 규칙이 올바르지 않습니다.');
      const evidenceRef = this.requiredText(item.providerEvidenceRef, 'providerEvidenceRef', 1000);
      const facts = this.normalizeFacts(item.ledgerFacts);
      try {
        return {
          prevStatus: this.requiredText(item.prevStatus, 'prevStatus', 32),
          newStatus: this.requiredText(item.newStatus, 'newStatus', 32),
          sourceEventIdOrigin: origin,
          sourceEventId,
          providerEvidenceRef: evidenceRef,
          providerEvidenceHash: computeEvidenceHash(evidenceRef),
          sourceOccurredAt: toDbDateTimeString(parseKstDateTime(item.sourceOccurredAt)),
          occurredAt: toDbDateTimeString(parseKstDateTime(item.occurredAt)),
          ledgerFacts: facts,
        };
      } catch (error) {
        if (error instanceof SettleTimeParseError)
          throw new BadRequestException('sourceOccurredAt과 occurredAt은 KST DATETIME(6) 형식이어야 합니다.');
        throw error;
      }
    });
    return { requestKey, transitions, reason: this.optionalText(command.reason, 1000) };
  }
  private normalizeFacts(raw: unknown): ForwardFacts | ReversalFacts {
    if (!raw || typeof raw !== 'object') throw new BadRequestException('ledgerFacts가 필요합니다.');
    const facts = raw as any;
    if (facts.action === 'FORWARD')
      return {
        action: 'FORWARD',
        baseAmount: this.amount(facts.baseAmount),
        subItemKey: this.requiredText(facts.subItemKey, 'subItemKey', 255),
      };
    if (facts.action === 'REVERSAL') {
      if (!Array.isArray(facts.allocations) || !facts.allocations.length)
        throw new BadRequestException('REVERSAL allocations가 필요합니다.');
      const allocations: { reversesLedgerId: number; cancelBaseAmount: string }[] = facts.allocations.map((a: any) => ({
        reversesLedgerId: a?.reversesLedgerId,
        cancelBaseAmount: this.amount(a?.cancelBaseAmount),
      }));
      if (
        allocations.some(
          (a: { reversesLedgerId: number }) => !Number.isInteger(a.reversesLedgerId) || a.reversesLedgerId <= 0,
        )
      )
        throw new BadRequestException('reversesLedgerId가 올바르지 않습니다.');
      allocations.sort(
        (a: { reversesLedgerId: number }, b: { reversesLedgerId: number }) => a.reversesLedgerId - b.reversesLedgerId,
      );
      if (
        allocations.some(
          (a: { reversesLedgerId: number }, i: number) =>
            i && a.reversesLedgerId === allocations[i - 1].reversesLedgerId,
        )
      )
        throw new BadRequestException('reversesLedgerId 중복은 허용되지 않습니다.');
      return { action: 'REVERSAL', allocations };
    }
    throw new BadRequestException('ledgerFacts action이 올바르지 않습니다.');
  }
  private amount(value: unknown) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
      throw new BadRequestException('금액은 canonical 양의 정수 문자열이어야 합니다.');
    return value;
  }
  private validateChain(observation: PartnerSettleTransitionObservationEntity, transitions: Transition[]) {
    if (
      transitions[0].prevStatus !== observation.prevStatus ||
      transitions[transitions.length - 1].newStatus !== observation.newStatus
    )
      throw new BadRequestException('관측 상태와 전이 사슬이 일치하지 않습니다.');
    for (let i = 1; i < transitions.length; i++)
      if (
        transitions[i - 1].newStatus !== transitions[i].prevStatus ||
        transitions[i - 1].occurredAt > transitions[i].occurredAt ||
        transitions[i - 1].sourceOccurredAt > transitions[i].sourceOccurredAt
      )
        throw new BadRequestException('전이 순서 또는 시각이 올바르지 않습니다.');
  }
  private payloadHash(observationId: number, command: { transitions: Transition[]; reason: string | null }) {
    return computePayloadHash(
      { observationId, transitions: command.transitions, reason: command.reason },
      HASH_VERSION,
    );
  }
  private bundleHash(transitions: Transition[]) {
    return computePayloadHash(
      {
        allocations: transitions.flatMap((item, index) => {
          const allocationCount = item.ledgerFacts.action === 'FORWARD' ? 1 : item.ledgerFacts.allocations.length;
          return Array.from({ length: allocationCount }, (_, allocationIndex) => ({
            sequenceNo: index + 1,
            allocationNo: allocationIndex + 1,
            providerEvidenceHash: item.providerEvidenceHash,
          }));
        }),
      },
      HASH_VERSION,
    );
  }
  private requiredText(value: unknown, field: string, maximum: number) {
    const result = this.optionalText(value, maximum);
    if (!result) throw new BadRequestException(`${field}은(는) 필수입니다.`);
    return result;
  }
  private optionalText(value: unknown, maximum: number) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') throw new BadRequestException('문자열 값이 올바르지 않습니다.');
    const result = value.normalize('NFC').trim();
    if (!result) return null;
    if (result.length > maximum) throw new BadRequestException('문자열 길이가 너무 깁니다.');
    return result;
  }
}
