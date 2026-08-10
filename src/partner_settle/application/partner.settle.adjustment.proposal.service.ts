import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerSettleAdjustmentProposalEntity } from '../../entity/partner.settle.adjustment.proposal.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerSettleLedgerService, LedgerAdjustmentCommand } from './partner.settle.ledger.service';
import { PartnerSettlePricingResolverService } from './partner.settle.pricing.resolver.service';
import { calculateSettleAmounts } from '../domain/settle.amount';
import {
  buildResolutionGroupKey,
  computeIncrementalAmount,
  verifyGroupCompleteness,
  buildReversalGraph,
  graphLedgerIds,
  computeGraphTargets,
  PricingResult,
} from '../domain/discount.reprice';
import { computePayloadHash } from '../domain/proposal.hash';
import { parseKstDateTime, toDbDateTimeString, KstInstant } from '../domain/settle.time';
import { PricingProductSnapshot } from '../domain/partner.settle.pricing';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { IPartnerSettleAdjustmentProposalStatus } from '../interface/partner.settle.adjustment.proposal.status';

export type AdjustmentActor = {
  id: number;
  email: string;
};

type GroupState = 'ALL_PENDING' | 'ALL_APPROVED' | 'ALL_REJECTED' | 'MIXED';

@Injectable()
export class PartnerSettleAdjustmentProposalService {
  private readonly logger = new Logger(PartnerSettleAdjustmentProposalService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ledgerService: PartnerSettleLedgerService,
    private readonly pricingResolver: PartnerSettlePricingResolverService,
  ) {}

  // ─── 조회 (§5.1) ───

  async findProposals(query: {
    partnerCompanyId?: number;
    status?: IPartnerSettleAdjustmentProposalStatus;
    resolutionGroupKey?: string;
    sourceLedgerId?: number;
    afterCreatedAt?: string;
    afterId?: number;
    limit?: number;
  }): Promise<PartnerSettleAdjustmentProposalEntity[]> {
    const limit = Math.min(query.limit ?? 50, 200);

    const qb = this.dataSource
      .getRepository(PartnerSettleAdjustmentProposalEntity)
      .createQueryBuilder('p')
      .orderBy('p.createdAt', 'ASC')
      .addOrderBy('p.id', 'ASC')
      .take(limit);

    if (query.partnerCompanyId) qb.andWhere('p.partnerCompanyId = :pcId', { pcId: query.partnerCompanyId });
    if (query.status) qb.andWhere('p.status = :status', { status: query.status });
    if (query.resolutionGroupKey) qb.andWhere('p.resolutionGroupKey = :gk', { gk: query.resolutionGroupKey });
    if (query.sourceLedgerId) qb.andWhere('p.sourceLedgerId = :slId', { slId: query.sourceLedgerId });

    if (query.afterCreatedAt && query.afterId) {
      qb.andWhere('(p.createdAt > :ac OR (p.createdAt = :ac AND p.id > :aid))', {
        ac: query.afterCreatedAt,
        aid: query.afterId,
      });
    }

    return qb.getMany();
  }

  // ─── 수동 생성 (§5.2) ───

  async createManual(
    dto: {
      partnerCompanyId: number;
      subItemKey: string;
      sourceLedgerId?: number | null;
      amount: string;
      reason: string;
      requestKey: string;
    },
    actor: AdjustmentActor,
    manager?: EntityManager,
  ): Promise<PartnerSettleAdjustmentProposalEntity> {
    if (manager) {
      return this.createManualInner(dto, actor, manager);
    }
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const result = await this.createManualInner(dto, actor, qr.manager);
      await qr.commitTransaction();
      return result;
    } catch (e) {
      await qr.rollbackTransaction();
      if (this.isDuplicateKeyError(e)) {
        const existing = await this.dataSource
          .getRepository(PartnerSettleAdjustmentProposalEntity)
          .findOne({ where: { requestKey: dto.requestKey } });
        if (existing) {
          const payloadHash = computePayloadHash(
            {
              partnerCompanyId: dto.partnerCompanyId,
              subItemKey: dto.subItemKey,
              sourceLedgerId: dto.sourceLedgerId ?? null,
              amount: dto.amount,
              reason: dto.reason,
            },
            'v1',
          );
          if (existing.payloadHash !== payloadHash) {
            throw new ConflictException(`requestKey '${dto.requestKey}' 에 다른 payload 가 이미 등록되어 있습니다.`);
          }
          return existing;
        }
      }
      throw e;
    } finally {
      await qr.release();
    }
  }

  private async createManualInner(
    dto: {
      partnerCompanyId: number;
      subItemKey: string;
      sourceLedgerId?: number | null;
      amount: string;
      reason: string;
      requestKey: string;
    },
    actor: AdjustmentActor,
    mgr: EntityManager,
  ): Promise<PartnerSettleAdjustmentProposalEntity> {
    const payloadHash = computePayloadHash(
      {
        partnerCompanyId: dto.partnerCompanyId,
        subItemKey: dto.subItemKey,
        sourceLedgerId: dto.sourceLedgerId ?? null,
        amount: dto.amount,
        reason: dto.reason,
      },
      'v1',
    );

    const existing = await mgr
      .getRepository(PartnerSettleAdjustmentProposalEntity)
      .findOne({ where: { requestKey: dto.requestKey } });

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ConflictException(`requestKey '${dto.requestKey}' 에 다른 payload 가 이미 등록되어 있습니다.`);
      }
      return existing;
    }

    if (dto.sourceLedgerId) {
      const ledger = await mgr
        .getRepository(PartnerSettleLedgerEntity)
        .createQueryBuilder('l')
        .setLock('pessimistic_write')
        .where('l.id = :id', { id: dto.sourceLedgerId })
        .getOne();

      if (!ledger) throw new NotFoundException(`source ledger ${dto.sourceLedgerId} 을 찾을 수 없습니다.`);
      if (ledger.partnerCompanyId !== dto.partnerCompanyId) {
        throw new BadRequestException('source ledger 의 partnerCompanyId 가 일치하지 않습니다.');
      }
      if (ledger.subItemKey !== dto.subItemKey) {
        throw new BadRequestException('source ledger 의 subItemKey 가 일치하지 않습니다.');
      }
      if (ledger.status !== 'NORMAL' && ledger.status !== 'ON_HOLD') {
        throw new BadRequestException(`source ledger 의 status 가 ${ledger.status} 여서 제안을 생성할 수 없습니다.`);
      }
    }

    const proposal = mgr.getRepository(PartnerSettleAdjustmentProposalEntity).create({
      partnerCompanyId: dto.partnerCompanyId,
      subItemKey: dto.subItemKey,
      sourceLedgerId: dto.sourceLedgerId ?? null,
      discountChangeId: null,
      proposedAmount: dto.amount,
      reason: dto.reason,
      status: 'PENDING',
      createdBy: actor.id,
      requestKey: dto.requestKey,
      payloadHash,
      payloadHashVersion: 'v1',
      resolutionGroupKey: null,
    });

    return mgr.getRepository(PartnerSettleAdjustmentProposalEntity).save(proposal);
  }

  // ─── 승인 (§5.3, §5.5) ───

  async approve(
    id: number,
    dto: { amount?: string; amountOverrideReason?: string },
    actor: AdjustmentActor,
  ): Promise<{ proposals: PartnerSettleAdjustmentProposalEntity[]; ledgerIds: number[] }> {
    const preview = await this.dataSource
      .getRepository(PartnerSettleAdjustmentProposalEntity)
      .findOne({ where: { id } });
    if (!preview) throw new NotFoundException(`adjustment proposal ${id} 을 찾을 수 없습니다.`);

    if (preview.resolutionGroupKey) {
      if (dto.amount !== undefined || dto.amountOverrideReason !== undefined) {
        throw new BadRequestException('그룹 proposal 은 금액 override 를 지원하지 않습니다. 개별 override 가 필요하면 단건 proposal 로 생성하세요.');
      }
      return this.approveGroup(preview.resolutionGroupKey, actor);
    }

    return this.approveSingle(id, dto, actor);
  }

  private async approveSingle(
    id: number,
    dto: { amount?: string; amountOverrideReason?: string },
    actor: AdjustmentActor,
  ): Promise<{ proposals: PartnerSettleAdjustmentProposalEntity[]; ledgerIds: number[] }> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const manager = qr.manager;

      const { proposal, sourceLedger } = await this.lockSingleScope(manager, id);

      if (proposal.status === 'APPROVED') {
        await qr.commitTransaction();
        return { proposals: [proposal], ledgerIds: proposal.resultLedgerId ? [proposal.resultLedgerId] : [] };
      }
      if (proposal.status === 'REJECTED') {
        throw new ConflictException(`adjustment proposal ${id} 은 이미 반려되었습니다.`);
      }

      this.assertNotSelfDecision(proposal, actor);

      const approvedAdjSum = await this.sumApprovedAdjustments(manager, proposal.sourceLedgerId, proposal.id);

      let finalAmount: bigint;
      if (sourceLedger && sourceLedger.settleAmount !== null) {
        const pricing = await this.pricingResolver.resolveAt(
          sourceLedger.partnerCompanyId,
          sourceLedger.occurredAt!,
          await this.loadSnapshot(sourceLedger.orderDeliveryId, manager),
          manager,
        );
        if (pricing.status === 'NEEDS_REVIEW') {
          throw new ConflictException('source ledger 의 pricing 이 NEEDS_REVIEW 상태라 승인할 수 없습니다.');
        }
        const target = calculateSettleAmounts({
          baseAmount: BigInt(sourceLedger.baseAmount!),
          pricePercent: pricing.pricePercent,
          priceAdjustment: pricing.priceAdjustment,
          vatCalculationMode: sourceLedger.vatCalculationMode,
          discountAmount: BigInt(sourceLedger.discountAmount ?? '0'),
        });
        finalAmount = computeIncrementalAmount(target.settleAmount, BigInt(sourceLedger.settleAmount), approvedAdjSum);
      } else {
        finalAmount = BigInt(proposal.proposedAmount);
      }

      let approvedAmount: bigint;
      let overrideReason: string | null = dto.amountOverrideReason ?? null;
      if (dto.amount !== undefined) {
        approvedAmount = BigInt(dto.amount);
        if (approvedAmount !== BigInt(proposal.proposedAmount) && !overrideReason) {
          throw new BadRequestException('proposedAmount 와 다른 금액을 승인하려면 amountOverrideReason 이 필수입니다.');
        }
      } else {
        approvedAmount = finalAmount;
        if (approvedAmount !== BigInt(proposal.proposedAmount)) {
          overrideReason = '승인 시점 재검증에 의한 차액 자동 보정';
        }
      }

      const decisionAt = await this.readDbNow(manager);
      const decisionAtDb = toDbDateTimeString(decisionAt);

      let resultLedgerId: number | null = null;
      if (approvedAmount !== 0n) {
        const ledger = await this.ledgerService.appendAdjustmentLedger(
          {
            partnerCompanyId: proposal.partnerCompanyId,
            subItemKey: proposal.subItemKey,
            adjustmentProposalId: proposal.id,
            settleAmount: approvedAmount,
            occurredAt: decisionAt,
            memo: proposal.reason,
          },
          manager,
        );
        resultLedgerId = ledger.id;
      }

      await manager.query(
        `UPDATE partner_settle_adjustment_proposal
            SET status = 'APPROVED', decided_by = ?, decided_at = ?,
                approved_amount = ?, result_ledger_id = ?,
                amount_override_reason = ?, decision_reason = ?
          WHERE id = ? AND status = 'PENDING'`,
        [
          actor.id,
          decisionAtDb,
          String(approvedAmount),
          resultLedgerId,
          overrideReason,
          null,
          proposal.id,
        ],
      );

      await qr.commitTransaction();

      const updated = await this.dataSource
        .getRepository(PartnerSettleAdjustmentProposalEntity)
        .findOneOrFail({ where: { id: proposal.id } });

      return { proposals: [updated], ledgerIds: resultLedgerId ? [resultLedgerId] : [] };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  private async approveGroup(
    groupKey: string,
    actor: AdjustmentActor,
  ): Promise<{ proposals: PartnerSettleAdjustmentProposalEntity[]; ledgerIds: number[] }> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const manager = qr.manager;

      const allProposals = await manager
        .getRepository(PartnerSettleAdjustmentProposalEntity)
        .find({ where: { resolutionGroupKey: groupKey }, order: { id: 'ASC' } });

      if (allProposals.length === 0) {
        throw new NotFoundException(`resolutionGroupKey '${groupKey}' 의 proposal 이 없습니다.`);
      }

      const groupState = this.classifyGroupState(allProposals);
      if (groupState === 'ALL_APPROVED') {
        await qr.commitTransaction();
        return {
          proposals: allProposals,
          ledgerIds: allProposals.filter((p) => p.resultLedgerId).map((p) => p.resultLedgerId!),
        };
      }
      if (groupState === 'ALL_REJECTED') {
        throw new ConflictException(`그룹 '${groupKey}' 는 이미 반려되었습니다.`);
      }
      if (groupState === 'MIXED') {
        throw new ConflictException(`그룹 '${groupKey}' 에 PENDING 과 terminal 이 혼재합니다 (데이터 오염).`);
      }

      const partnerCompanyId = allProposals[0].partnerCompanyId;

      await manager
        .getRepository(PartnerCompanyEntity)
        .createQueryBuilder('pc')
        .setLock('pessimistic_write')
        .where('pc.id = :id', { id: partnerCompanyId })
        .getOneOrFail();

      const sourceLedgerIds = allProposals
        .filter((p) => p.sourceLedgerId !== null)
        .map((p) => p.sourceLedgerId!)
        .sort((a, b) => a - b);

      const sourceLedgers = sourceLedgerIds.length > 0
        ? await manager
            .getRepository(PartnerSettleLedgerEntity)
            .createQueryBuilder('l')
            .setLock('pessimistic_write')
            .where('l.id IN (:...ids)', { ids: sourceLedgerIds })
            .orderBy('l.id', 'ASC')
            .getMany()
        : [];

      const proposalIds = allProposals.map((p) => p.id).sort((a, b) => a - b);
      const lockedProposals = await manager
        .getRepository(PartnerSettleAdjustmentProposalEntity)
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.id IN (:...ids)', { ids: proposalIds })
        .orderBy('p.id', 'ASC')
        .getMany();

      const lockedGroupState = this.classifyGroupState(lockedProposals);
      if (lockedGroupState === 'ALL_APPROVED') {
        await qr.commitTransaction();
        return {
          proposals: lockedProposals,
          ledgerIds: lockedProposals.filter((p) => p.resultLedgerId).map((p) => p.resultLedgerId!),
        };
      }
      if (lockedGroupState !== 'ALL_PENDING') {
        throw new ConflictException(`그룹 '${groupKey}' 의 상태가 잠금 후 변경되었습니다.`);
      }

      for (const p of lockedProposals) {
        this.assertNotSelfDecision(p, actor);
      }

      // graph completeness (§5.5 item 4): actual DB graph vs proposal coverage
      if (sourceLedgers.length > 0) {
        const rootLedger = sourceLedgers.find((l) => l.reversesLedgerId === null);
        if (!rootLedger) {
          throw new ConflictException(`그룹 '${groupKey}' 에 root ledger(reversesLedgerId=null)가 없습니다.`);
        }

        const allReversals = await manager
          .getRepository(PartnerSettleLedgerEntity)
          .createQueryBuilder('l')
          .where('l.partnerCompanyId = :pcId', { pcId: partnerCompanyId })
          .andWhere('l.reversesLedgerId IS NOT NULL')
          .orderBy('l.id', 'ASC')
          .getMany();

        const actualDescendants = buildReversalGraph(rootLedger, allReversals);
        const actualNodeIds = graphLedgerIds(rootLedger, actualDescendants);
        const proposalSourceIds = lockedProposals.map((p) => p.sourceLedgerId!);
        if (!verifyGroupCompleteness(actualNodeIds, proposalSourceIds)) {
          throw new ConflictException(`그룹 '${groupKey}' 에 누락된 reversal proposal 이 있습니다.`);
        }

        // lock any graph nodes not yet locked via sourceLedgerIds
        const missingLockIds = actualNodeIds.filter((id) => !sourceLedgerIds.includes(id));
        if (missingLockIds.length > 0) {
          await manager
            .getRepository(PartnerSettleLedgerEntity)
            .createQueryBuilder('l')
            .setLock('pessimistic_write')
            .where('l.id IN (:...ids)', { ids: missingLockIds })
            .orderBy('l.id', 'ASC')
            .getMany();
        }
      }

      const decisionAt = await this.readDbNow(manager);
      const decisionAtDb = toDbDateTimeString(decisionAt);
      const ledgerIds: number[] = [];

      // graph-aware target calculation (reversal rows use parent's target, not independent recalc)
      const graphTargets = await this.computeGroupGraphTargets(sourceLedgers, manager);

      for (const proposal of lockedProposals) {
        const approvedAdjSum = await this.sumApprovedAdjustments(manager, proposal.sourceLedgerId, proposal.id);
        const sourceLedger = sourceLedgers.find((l) => l.id === proposal.sourceLedgerId);
        let approvedAmount: bigint;
        let overrideReason: string | null = null;

        const graphTarget = proposal.sourceLedgerId !== null ? graphTargets.get(proposal.sourceLedgerId) : undefined;
        if (graphTarget !== undefined && sourceLedger && sourceLedger.settleAmount !== null) {
          approvedAmount = computeIncrementalAmount(
            graphTarget,
            BigInt(sourceLedger.settleAmount),
            approvedAdjSum,
          );
        } else {
          approvedAmount = BigInt(proposal.proposedAmount);
        }

        if (approvedAmount !== BigInt(proposal.proposedAmount)) {
          overrideReason = '승인 시점 재검증에 의한 차액 자동 보정';
        }

        let resultLedgerId: number | null = null;
        if (approvedAmount !== 0n) {
          const ledger = await this.ledgerService.appendAdjustmentLedger(
            {
              partnerCompanyId: proposal.partnerCompanyId,
              subItemKey: proposal.subItemKey,
              adjustmentProposalId: proposal.id,
              settleAmount: approvedAmount,
              occurredAt: decisionAt,
              memo: proposal.reason,
            },
            manager,
          );
          resultLedgerId = ledger.id;
          ledgerIds.push(ledger.id);
        }

        await manager.query(
          `UPDATE partner_settle_adjustment_proposal
              SET status = 'APPROVED', decided_by = ?, decided_at = ?,
                  approved_amount = ?, result_ledger_id = ?,
                  amount_override_reason = ?
            WHERE id = ? AND status = 'PENDING'`,
          [actor.id, decisionAtDb, String(approvedAmount), resultLedgerId, overrideReason, proposal.id],
        );
      }

      await qr.commitTransaction();

      const updatedProposals = await this.dataSource
        .getRepository(PartnerSettleAdjustmentProposalEntity)
        .find({ where: { resolutionGroupKey: groupKey }, order: { id: 'ASC' } });

      return { proposals: updatedProposals, ledgerIds };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ─── 반려 (§5.8) ───

  async reject(
    id: number,
    dto: { reason: string },
    actor: AdjustmentActor,
  ): Promise<{ proposals: PartnerSettleAdjustmentProposalEntity[] }> {
    const preview = await this.dataSource
      .getRepository(PartnerSettleAdjustmentProposalEntity)
      .findOne({ where: { id } });
    if (!preview) throw new NotFoundException(`adjustment proposal ${id} 을 찾을 수 없습니다.`);

    if (preview.resolutionGroupKey) {
      return this.rejectGroup(preview.resolutionGroupKey, dto.reason, actor);
    }

    return this.rejectSingle(id, dto.reason, actor);
  }

  private async rejectSingle(
    id: number,
    reason: string,
    actor: AdjustmentActor,
  ): Promise<{ proposals: PartnerSettleAdjustmentProposalEntity[] }> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const manager = qr.manager;

      const { proposal } = await this.lockSingleScope(manager, id);

      if (proposal.status === 'REJECTED') {
        await qr.commitTransaction();
        return { proposals: [proposal] };
      }
      if (proposal.status === 'APPROVED') {
        throw new ConflictException(`adjustment proposal ${id} 은 이미 승인되었습니다.`);
      }

      this.assertNotSelfDecision(proposal, actor);

      const decisionAt = await this.readDbNow(manager);
      const decisionAtDb = toDbDateTimeString(decisionAt);

      await manager.query(
        `UPDATE partner_settle_adjustment_proposal
            SET status = 'REJECTED', decided_by = ?, decided_at = ?, decision_reason = ?
          WHERE id = ? AND status = 'PENDING'`,
        [actor.id, decisionAtDb, reason, proposal.id],
      );

      await qr.commitTransaction();

      const updated = await this.dataSource
        .getRepository(PartnerSettleAdjustmentProposalEntity)
        .findOneOrFail({ where: { id: proposal.id } });

      return { proposals: [updated] };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  private async rejectGroup(
    groupKey: string,
    reason: string,
    actor: AdjustmentActor,
  ): Promise<{ proposals: PartnerSettleAdjustmentProposalEntity[] }> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const manager = qr.manager;

      const allProposals = await manager
        .getRepository(PartnerSettleAdjustmentProposalEntity)
        .find({ where: { resolutionGroupKey: groupKey }, order: { id: 'ASC' } });

      if (allProposals.length === 0) {
        throw new NotFoundException(`resolutionGroupKey '${groupKey}' 의 proposal 이 없습니다.`);
      }

      const groupState = this.classifyGroupState(allProposals);
      if (groupState === 'ALL_REJECTED') {
        await qr.commitTransaction();
        return { proposals: allProposals };
      }
      if (groupState === 'ALL_APPROVED') {
        throw new ConflictException(`그룹 '${groupKey}' 는 이미 승인되었습니다.`);
      }
      if (groupState === 'MIXED') {
        throw new ConflictException(`그룹 '${groupKey}' 에 PENDING 과 terminal 이 혼재합니다 (데이터 오염).`);
      }

      const partnerCompanyId = allProposals[0].partnerCompanyId;

      await manager
        .getRepository(PartnerCompanyEntity)
        .createQueryBuilder('pc')
        .setLock('pessimistic_write')
        .where('pc.id = :id', { id: partnerCompanyId })
        .getOneOrFail();

      const proposalIds = allProposals.map((p) => p.id).sort((a, b) => a - b);
      const lockedProposals = await manager
        .getRepository(PartnerSettleAdjustmentProposalEntity)
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.id IN (:...ids)', { ids: proposalIds })
        .orderBy('p.id', 'ASC')
        .getMany();

      const lockedGroupState = this.classifyGroupState(lockedProposals);
      if (lockedGroupState === 'ALL_REJECTED') {
        await qr.commitTransaction();
        return { proposals: lockedProposals };
      }
      if (lockedGroupState !== 'ALL_PENDING') {
        throw new ConflictException(`그룹 '${groupKey}' 의 상태가 잠금 후 변경되었습니다.`);
      }

      for (const p of lockedProposals) {
        this.assertNotSelfDecision(p, actor);
      }

      const decisionAt = await this.readDbNow(manager);
      const decisionAtDb = toDbDateTimeString(decisionAt);

      for (const proposal of lockedProposals) {
        await manager.query(
          `UPDATE partner_settle_adjustment_proposal
              SET status = 'REJECTED', decided_by = ?, decided_at = ?, decision_reason = ?
            WHERE id = ? AND status = 'PENDING'`,
          [actor.id, decisionAtDb, reason, proposal.id],
        );
      }

      await qr.commitTransaction();

      const updatedProposals = await this.dataSource
        .getRepository(PartnerSettleAdjustmentProposalEntity)
        .find({ where: { resolutionGroupKey: groupKey }, order: { id: 'ASC' } });

      return { proposals: updatedProposals };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ─── 소급 재계산 proposal 일괄 생성 (§4 — reprice service 가 호출) ───

  async createRepriceProposals(
    params: {
      partnerCompanyId: number;
      rootLedger: PartnerSettleLedgerEntity;
      descendants: PartnerSettleLedgerEntity[];
      discountChangeId: number;
      seeds: { sourceLedgerId: number; proposedAmount: bigint; reason: string }[];
    },
    manager: EntityManager,
  ): Promise<PartnerSettleAdjustmentProposalEntity[]> {
    const groupKey = buildResolutionGroupKey(params.rootLedger.id, params.discountChangeId);

    const proposals: PartnerSettleAdjustmentProposalEntity[] = [];
    for (const seed of params.seeds) {
      const existing = await manager
        .getRepository(PartnerSettleAdjustmentProposalEntity)
        .findOne({
          where: {
            sourceLedgerId: seed.sourceLedgerId,
            discountChangeId: params.discountChangeId,
          },
        });

      if (existing) {
        proposals.push(existing);
        continue;
      }

      const ledger = [params.rootLedger, ...params.descendants].find((l) => l.id === seed.sourceLedgerId);

      const proposal = manager.getRepository(PartnerSettleAdjustmentProposalEntity).create({
        partnerCompanyId: params.partnerCompanyId,
        subItemKey: ledger?.subItemKey ?? 'NONE',
        sourceLedgerId: seed.sourceLedgerId,
        discountChangeId: params.discountChangeId,
        proposedAmount: String(seed.proposedAmount),
        reason: seed.reason,
        status: 'PENDING',
        createdBy: null,
        resolutionGroupKey: groupKey,
        requestKey: null,
        payloadHash: null,
        payloadHashVersion: null,
      });

      const saved = await manager.getRepository(PartnerSettleAdjustmentProposalEntity).save(proposal);
      proposals.push(saved);
    }

    return proposals;
  }

  // ─── Internal helpers ───

  private async lockSingleScope(
    manager: EntityManager,
    id: number,
  ): Promise<{
    proposal: PartnerSettleAdjustmentProposalEntity;
    sourceLedger: PartnerSettleLedgerEntity | null;
  }> {
    const preview = await manager
      .getRepository(PartnerSettleAdjustmentProposalEntity)
      .findOne({ where: { id } });
    if (!preview) throw new NotFoundException(`adjustment proposal ${id} 을 찾을 수 없습니다.`);

    await manager
      .getRepository(PartnerCompanyEntity)
      .createQueryBuilder('pc')
      .setLock('pessimistic_write')
      .where('pc.id = :id', { id: preview.partnerCompanyId })
      .getOneOrFail();

    let sourceLedger: PartnerSettleLedgerEntity | null = null;
    if (preview.sourceLedgerId !== null) {
      sourceLedger = await manager
        .getRepository(PartnerSettleLedgerEntity)
        .createQueryBuilder('l')
        .setLock('pessimistic_write')
        .where('l.id = :id', { id: preview.sourceLedgerId })
        .getOne();
    }

    const proposal = await manager
      .getRepository(PartnerSettleAdjustmentProposalEntity)
      .createQueryBuilder('p')
      .setLock('pessimistic_write')
      .where('p.id = :id', { id })
      .getOne();
    if (!proposal) throw new NotFoundException(`adjustment proposal ${id} 을 찾을 수 없습니다.`);

    return { proposal, sourceLedger };
  }

  private classifyGroupState(proposals: PartnerSettleAdjustmentProposalEntity[]): GroupState {
    const statuses = new Set(proposals.map((p) => p.status));
    if (statuses.size === 1) {
      const s = statuses.values().next().value!;
      if (s === 'PENDING') return 'ALL_PENDING';
      if (s === 'APPROVED') return 'ALL_APPROVED';
      if (s === 'REJECTED') return 'ALL_REJECTED';
    }
    return 'MIXED';
  }

  private async sumApprovedAdjustments(
    manager: EntityManager,
    sourceLedgerId: number | null,
    excludeProposalId: number,
  ): Promise<bigint> {
    if (sourceLedgerId === null) return 0n;

    const result = await manager
      .createQueryBuilder()
      .select('COALESCE(SUM(CAST(p.approved_amount AS SIGNED)), 0)', 'total')
      .from('partner_settle_adjustment_proposal', 'p')
      .where('p.source_ledger_id = :slId', { slId: sourceLedgerId })
      .andWhere("p.status = 'APPROVED'")
      .andWhere('p.id != :excludeId', { excludeId: excludeProposalId })
      .getRawOne();

    return BigInt(result?.total ?? 0);
  }

  private isDuplicateKeyError(e: unknown): boolean {
    return e instanceof Error && 'code' in e && (e as any).code === 'ER_DUP_ENTRY';
  }

  private assertNotSelfDecision(
    proposal: PartnerSettleAdjustmentProposalEntity,
    actor: AdjustmentActor,
  ): void {
    if (proposal.createdBy !== null && proposal.createdBy === actor.id) {
      throw new ForbiddenException('차액 제안은 생성자와 다른 사람이 결정해야 합니다.');
    }
  }

  private async readDbNow(manager: EntityManager): Promise<KstInstant> {
    const rows = await manager.query(`SELECT DATE_FORMAT(NOW(6), '%Y-%m-%d %H:%i:%s.%f') AS now6`);
    const now6 = rows?.[0]?.now6;
    if (!now6) throw new ConflictException('DB 기준 시각을 읽지 못했습니다.');
    return parseKstDateTime(String(now6));
  }

  private async computeGroupGraphTargets(
    sourceLedgers: PartnerSettleLedgerEntity[],
    manager: EntityManager,
  ): Promise<Map<number, bigint>> {
    if (sourceLedgers.length === 0) return new Map();

    const rootLedger = sourceLedgers.find((l) => l.reversesLedgerId === null);
    if (!rootLedger) {
      throw new ConflictException('그룹 source ledger 중 root(reversesLedgerId=null)를 찾을 수 없습니다.');
    }

    const descendants = sourceLedgers.filter((l) => l.id !== rootLedger.id);

    const pricing = await this.pricingResolver.resolveAt(
      rootLedger.partnerCompanyId,
      rootLedger.occurredAt!,
      await this.loadSnapshot(rootLedger.orderDeliveryId, manager),
      manager,
    );
    if (pricing.status === 'NEEDS_REVIEW') {
      throw new ConflictException(`source ledger ${rootLedger.id} 의 pricing 이 NEEDS_REVIEW — 그룹 승인 불가`);
    }

    const pricingResult: PricingResult = {
      pricePercent: String(pricing.pricePercent),
      priceAdjustment: pricing.priceAdjustment,
      appliedDiscountHistoryId: pricing.appliedDiscountHistoryId,
      pricingResolution: pricing.pricingResolution as 'HISTORY_MATCH' | 'NO_MATCH',
    };

    return computeGraphTargets(rootLedger, descendants, pricingResult);
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
}
