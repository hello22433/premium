import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { TrackingCreatedByOp } from '../interface/delivery.workflow.status';
import {
  PIN_ISSUE_ACTIVE_STATUSES,
  PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES,
  PinIssueCommandStatus,
  SsgPinResolution,
} from '../interface/pin.issue.command.status';

export interface PinIssueCommandAuthority {
  commandId: string;
  ownerToken: string;
  generation: string;
  workflowVersion: string;
}
/**
 * A command may authorize exactly the consumed initial INSERT or the consumed
 * NOT_ISSUED retry INSERT. Keep this predicate shared by the durable fence and
 * the immediate pre-HTTP recheck.
 */
export function hasConsumedSsgIssueAuthority(
  command: Pick<PinIssueCommandEntity, 'status' | 'externalIssueCount'> | null | undefined,
): boolean {
  return (
    (command?.status === PinIssueCommandStatus.STARTED && command.externalIssueCount === 1) ||
    (command?.status === PinIssueCommandStatus.RETRYING && command.externalIssueCount === 2)
  );
}

/**
 * Durable authority for SSG PIN INSERT calls. Every authority mutation is a
 * conditional UPDATE; a zero affected-row result means the worker is stale and
 * must not call SSG. These methods deliberately propagate database failures.
 */
@Injectable()
export class PinIssueCommandService {
  private readonly logger = new Logger(PinIssueCommandService.name);

  constructor(
    @InjectRepository(PinIssueCommandEntity)
    private readonly repository: Repository<PinIssueCommandEntity>,
  ) {}

  /** Atomically creates the one active command permitted for an order delivery. */
  async createActiveCommand(params: {
    orderDeliveryId: number;
    partnerType: string;
    requestKey: string | null;
    ownerToken: string;
    generation: string;
    workflowVersion: string;
    leaseExpiresAt: Date;
    createdByOp: TrackingCreatedByOp;
    deliveryClaimToken?: string | null;
  }): Promise<string> {
    const result = await this.repository.insert({
      orderDeliveryId: params.orderDeliveryId,
      partnerType: params.partnerType,
      requestKey: params.requestKey,
      status: PinIssueCommandStatus.STARTED,
      ownerToken: params.ownerToken,
      generation: params.generation,
      workflowVersion: params.workflowVersion,
      deliveryClaimToken: toIsoDeliveryClaimToken(params.deliveryClaimToken ?? params.ownerToken),
      leaseExpiresAt: params.leaseExpiresAt,
      createdByOp: params.createdByOp,
      createdWorkflowVersion: params.workflowVersion,
      stateEnteredAt: new Date(),
    });
    return String(result.identifiers[0].id);
  }

  async findActiveCommand(orderDeliveryId: number): Promise<PinIssueCommandEntity | null> {
    return this.repository.findOne({
      where: { orderDeliveryId, status: In(PIN_ISSUE_ACTIVE_STATUSES) },
      order: { id: 'DESC' },
    });
  }

  /** 롤아웃 capability 판정(§9-3 drain marker)용 단건 조회. 권한 승인 근거로는 쓰지 않는다. */
  async findById(commandId: string): Promise<PinIssueCommandEntity | null> {
    return this.repository.findOne({ where: { id: commandId } });
  }

  async hasActiveCommand(orderDeliveryId: number): Promise<boolean> {
    return (await this.repository.count({ where: { orderDeliveryId, status: In(PIN_ISSUE_ACTIVE_STATUSES) } })) > 0;
  }

  /**
   * Consumes the sole initial SSG INSERT authority (0 → 1). The caller may
   * invoke SSG only after this returns true.
   */
  async consumeInitialIssueAuthority(authority: PinIssueCommandAuthority): Promise<boolean> {
    return this.consumeAuthority(authority, 0, PinIssueCommandStatus.STARTED);
  }

  /**
   * Consumes the sole NOT_ISSUED retry INSERT authority (1 → 2). No state or
   * lease recovery can make this condition true again.
   */
  async consumeNotIssuedRetryAuthority(authority: PinIssueCommandAuthority): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({ externalIssueCount: 2, stateEnteredAt: new Date() })
      .where('id = :commandId', { commandId: authority.commandId })
      .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
      .andWhere('generation = :generation', { generation: authority.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
      .andWhere('status = :status', { status: PinIssueCommandStatus.RETRYING })
      .andWhere('resolution = :resolution', { resolution: SsgPinResolution.NOT_ISSUED })
      .andWhere('external_issue_count = 1')
      .execute();
    return result.affected === 1;
  }

  /** CAS claim used by the resolution sweep before it performs a lookup. */
  async claimRetryPending(params: PinIssueCommandAuthority & { leaseExpiresAt: Date }): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({
        status: PinIssueCommandStatus.RETRYING,
        leaseExpiresAt: params.leaseExpiresAt,
        stateEnteredAt: new Date(),
      })
      .where('id = :commandId', { commandId: params.commandId })
      .andWhere('owner_token = :ownerToken', { ownerToken: params.ownerToken })
      .andWhere('generation = :generation', { generation: params.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: params.workflowVersion })
      .andWhere('status = :status', { status: PinIssueCommandStatus.RETRY_PENDING })
      .execute();
    return result.affected === 1;
  }
  /**
   * Returns only RETRY_PENDING commands still owned by this batch. General
   * selection must never use this path: deferred authority remains with the
   * owner through pass 2.
   */
  async findDeferredForResolution(ownerToken: string, ids: number[]): Promise<PinIssueCommandEntity[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.repository.find({
      where: {
        orderDeliveryId: In(ids),
        ownerToken,
        status: PinIssueCommandStatus.RETRY_PENDING,
      },
      order: { id: 'ASC' },
    });
  }

  /** Fenced result transition; stale workers cannot overwrite a current owner. */
  async recordResolution(
    authority: PinIssueCommandAuthority,
    params: {
      resolution: SsgPinResolution;
      status: PinIssueCommandStatus;
      nextAttemptAt?: Date | null;
      partnerResponseCode?: string | null;
    },
  ): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({
        resolution: params.resolution,
        status: params.status,
        nextAttemptAt: params.nextAttemptAt ?? null,
        partnerResponseCode: params.partnerResponseCode ? params.partnerResponseCode.slice(0, 32) : null,
        resolutionLookupCount: () => 'resolution_lookup_count + 1',
        resolutionStartedAt: () => 'COALESCE(resolution_started_at, CURRENT_TIMESTAMP(6))',
        stateEnteredAt: new Date(),
      })
      .where('id = :commandId', { commandId: authority.commandId })
      .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
      .andWhere('generation = :generation', { generation: authority.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
      .andWhere('status IN (:...allowedStatuses)', {
        allowedStatuses: PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES,
      })
      .execute();
    return result.affected === 1;
  }

  async markSucceeded(authority: PinIssueCommandAuthority): Promise<boolean> {
    return this.transitionOwned(authority, PinIssueCommandStatus.SUCCEEDED, SsgPinResolution.CONFIRMED);
  }
  /**
   * Releases a durable delivery claim and terminalizes the command in one
   * transaction, so either stale CAS leaves the command active.
   */
  async markSucceededAfterDeliveryClaimRelease(
    authority: PinIssueCommandAuthority,
    orderDeliveryId: number,
    deliveryClaimToken: string | null,
  ): Promise<boolean> {
    if (!deliveryClaimToken) return this.markSucceeded(authority);

    const claimedAt = new Date(deliveryClaimToken);
    if (Number.isNaN(claimedAt.getTime()) || claimedAt.toISOString() !== deliveryClaimToken) return false;

    try {
      return await this.repository.manager.transaction(async (manager) => {
        const released = await manager
          .createQueryBuilder()
          .update(OrderDeliveryEntity)
          .set({ claimedAt: null, mutationClaimedAt: null })
          .where('id = :id', { id: orderDeliveryId })
          .andWhere('claimed_at = :claimedAt', { claimedAt })
          .andWhere('mutation_claimed_at = :claimedAt', { claimedAt })
          .execute();
        if (released.affected !== 1) return false;

        const succeeded = await manager
          .createQueryBuilder()
          .update(PinIssueCommandEntity)
          .set({
            status: PinIssueCommandStatus.SUCCEEDED,
            resolution: SsgPinResolution.CONFIRMED,
            resolvedAt: new Date(),
            stateEnteredAt: new Date(),
          })
          .where('id = :commandId', { commandId: authority.commandId })
          .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
          .andWhere('generation = :generation', { generation: authority.generation })
          .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
          .andWhere('status IN (:...allowedStatuses)', {
            allowedStatuses: PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES,
          })
          .execute();
        if (succeeded.affected !== 1) throw new PinIssueCommandTransitionConflictError();
        return true;
      });
    } catch (error) {
      if (error instanceof PinIssueCommandTransitionConflictError) return false;
      throw error;
    }
  }

  /**
   * 자동 처리 불가 판정을 운영 확인으로 승격한다. `CONFIRMED` 는 성공 종결 경로(markSucceeded)
   * 소관이므로 여기로 들어오면 안 된다.
   */
  async markOpsReviewRequired(
    authority: PinIssueCommandAuthority,
    resolution: Exclude<SsgPinResolution, SsgPinResolution.CONFIRMED>,
  ): Promise<boolean> {
    return this.transitionOwned(authority, PinIssueCommandStatus.OPS_REVIEW_REQUIRED, resolution);
  }

  /** Best-effort audit only. It must never be used to authorize an SSG call. */
  async recordAttemptAudit(params: {
    orderDeliveryId: number;
    partnerType: string;
    requestKey: string | null;
  }): Promise<void> {
    try {
      await this.repository.insert({
        orderDeliveryId: params.orderDeliveryId,
        partnerType: params.partnerType,
        requestKey: params.requestKey,
        status: PinIssueCommandStatus.TERMINAL,
        createdByOp: 'LEGACY_SEND',
        createdWorkflowVersion: '0',
        stateEnteredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(`[PIN_CMD] audit write failed. odId=${params.orderDeliveryId}: ${error}`);
    }
  }

  private async consumeAuthority(
    authority: PinIssueCommandAuthority,
    expectedExternalIssueCount: number,
    status: PinIssueCommandStatus,
  ): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({ externalIssueCount: expectedExternalIssueCount + 1, stateEnteredAt: new Date() })
      .where('id = :commandId', { commandId: authority.commandId })
      .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
      .andWhere('generation = :generation', { generation: authority.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
      .andWhere('status = :status', { status })
      .andWhere('external_issue_count = :expectedExternalIssueCount', { expectedExternalIssueCount })
      .execute();
    return result.affected === 1;
  }

  private async transitionOwned(
    authority: PinIssueCommandAuthority,
    status: PinIssueCommandStatus,
    resolution: SsgPinResolution,
  ): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({ status, resolution, resolvedAt: new Date(), stateEnteredAt: new Date() })
      .where('id = :commandId', { commandId: authority.commandId })
      .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
      .andWhere('generation = :generation', { generation: authority.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
      .andWhere('status IN (:...allowedStatuses)', {
        allowedStatuses: PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES,
      })
      .execute();
    return result.affected === 1;
  }
}
function toIsoDeliveryClaimToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const claimedAt = new Date(token);
  return !Number.isNaN(claimedAt.getTime()) && claimedAt.toISOString() === token ? token : null;
}
class PinIssueCommandTransitionConflictError extends Error {}
