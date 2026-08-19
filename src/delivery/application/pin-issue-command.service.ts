import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliverySsgInsertStateEntity } from '../../entity/order.delivery.ssg.insert.state.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { TrackingCreatedByOp } from '../interface/delivery.workflow.status';
import {
  PIN_ISSUE_ACTIVE_STATUSES,
  PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES,
  PinIssueCommandStatus,
  SsgPinResolution,
} from '../interface/pin.issue.command.status';
import { SsgInsertState } from '../interface/ssg.insert.state';

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

  /**
   * §6-C 판정·streak·전이 단일 CAS.
   *
   * resolution 이 dead(NOT_ISSUED aggregate)면 not_issued_streak+1, 아니면 0 으로 리셋.
   * resolution_deadline_at 은 NULL 일 때만 1회 저장(COALESCE).
   */
  async recordResolution(
    authority: PinIssueCommandAuthority,
    params: {
      resolution: SsgPinResolution;
      status: PinIssueCommandStatus;
      nextAttemptAt?: Date | null;
      partnerResponseCode?: string | null;
      resolutionDeadlineAt?: Date | null;
      expectedLookupCount?: number;
    },
  ): Promise<boolean> {
    const isDeadResolution = params.resolution === SsgPinResolution.NOT_ISSUED;
    const qb = this.repository
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({
        resolution: params.resolution,
        status: params.status,
        nextAttemptAt: params.nextAttemptAt ?? null,
        partnerResponseCode: params.partnerResponseCode ? params.partnerResponseCode.slice(0, 32) : null,
        resolutionLookupCount: () => 'resolution_lookup_count + 1',
        resolutionStartedAt: () => 'COALESCE(resolution_started_at, CURRENT_TIMESTAMP(6))',
        notIssuedStreak: () => (isDeadResolution ? 'not_issued_streak + 1' : '0'),
        resolutionDeadlineAt: () =>
          params.resolutionDeadlineAt
            ? 'COALESCE(resolution_deadline_at, :deadlineParam)'
            : 'resolution_deadline_at',
        stateEnteredAt: new Date(),
      })
      .where('id = :commandId', { commandId: authority.commandId })
      .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
      .andWhere('generation = :generation', { generation: authority.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
      .andWhere('status IN (:...allowedStatuses)', {
        allowedStatuses: PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES,
      });
    if (params.resolutionDeadlineAt) {
      qb.setParameter('deadlineParam', params.resolutionDeadlineAt);
    }
    if (params.expectedLookupCount !== undefined) {
      qb.andWhere('resolution_lookup_count = :expectedLookupCount', {
        expectedLookupCount: params.expectedLookupCount,
      });
    }
    const result = await qb.execute();
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
   * §6-B LOOKUP_FAILED → delivery claim 해제 + command RETRY_PENDING.
   *
   * 조회 대기 중에는 delivery 를 점유할 이유가 없으므로 claim 을 풀어 CS·폐기가 진행되도록 한다.
   * 한 트랜잭션에서 delivery claim 해제 + command 상태 전이를 수행하므로, delivery CAS 실패 시
   * command 도 롤백돼 claim 불일치 없이 다음 sweep 에서 재시도한다.
   */
  async releaseClaimForRetryPending(
    authority: PinIssueCommandAuthority,
    orderDeliveryId: number,
    deliveryClaimToken: string | null,
    params: {
      resolution: SsgPinResolution;
      nextAttemptAt: Date;
      resolutionDeadlineAt?: Date | null;
      expectedLookupCount?: number;
    },
  ): Promise<boolean> {
    const isDeadResolution = params.resolution === SsgPinResolution.NOT_ISSUED;
    const claimedAt = deliveryClaimToken ? new Date(deliveryClaimToken) : null;
    const validClaim =
      claimedAt && !Number.isNaN(claimedAt.getTime()) && claimedAt.toISOString() === deliveryClaimToken;

    try {
      return await this.repository.manager.transaction(async (manager) => {
        if (validClaim) {
          const released = await manager
            .createQueryBuilder()
            .update(OrderDeliveryEntity)
            .set({ claimedAt: null, mutationClaimedAt: null })
            .where('id = :id', { id: orderDeliveryId })
            .andWhere('claimed_at = :claimedAt', { claimedAt })
            .andWhere('mutation_claimed_at = :claimedAt', { claimedAt })
            .execute();
          if (released.affected !== 1) return false;
        }

        const qb = manager
          .createQueryBuilder()
          .update(PinIssueCommandEntity)
          .set({
            status: PinIssueCommandStatus.RETRY_PENDING,
            resolution: params.resolution,
            deliveryClaimToken: null,
            nextAttemptAt: params.nextAttemptAt,
            leaseExpiresAt: null,
            resolutionLookupCount: () => 'resolution_lookup_count + 1',
            resolutionStartedAt: () => 'COALESCE(resolution_started_at, CURRENT_TIMESTAMP(6))',
            notIssuedStreak: () => (isDeadResolution ? 'not_issued_streak + 1' : '0'),
            resolutionDeadlineAt: () =>
              params.resolutionDeadlineAt
                ? 'COALESCE(resolution_deadline_at, :deadlineParam)'
                : 'resolution_deadline_at',
            stateEnteredAt: new Date(),
          })
          .where('id = :commandId', { commandId: authority.commandId })
          .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
          .andWhere('generation = :generation', { generation: authority.generation })
          .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
          .andWhere('status IN (:...allowedStatuses)', {
            allowedStatuses: PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES,
          });
        if (params.resolutionDeadlineAt) {
          qb.setParameter('deadlineParam', params.resolutionDeadlineAt);
        }
        if (params.expectedLookupCount !== undefined) {
          qb.andWhere('resolution_lookup_count = :expectedLookupCount', {
            expectedLookupCount: params.expectedLookupCount,
          });
        }
        const updated = await qb.execute();
        if (updated.affected !== 1) throw new PinIssueCommandTransitionConflictError();
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

  /**
   * §7-1 NOT_ATTEMPTED 권한 재점유 CAS.
   *
   * 앱 재시작 후 delivery claim 이 NULL 로 풀려 claimPinCommand 가 실패한 frozen command 를
   * STARTED+count=1 로 복원한다. 새 권한을 소비하는 게 아니라 **이미 소비한 1회를 회수**한다.
   *
   * 3중 증인: (1) ssg_issue_log 0행 (tombstone 포함) → INSERT 시도 없음
   *          (2) insert_state ATTEMPTED/CONFIRMED 없음 → 외부 PIN 미기록
   *          (3) order_delivery PIN payload 없음 → 최종 기록 미반영
   *
   * 성공 후 `hasConsumedSsgIssueAuthority(STARTED, 1) = true` 이므로 markAttempted 가 작동한다.
   * 반환값이 true 면 반드시 `reacquireDeliveryClaim` 으로 delivery claim 을 확보한 뒤에만
   * 외부 부작용(INSERT)을 실행한다.
   */
  async reclaimNotAttemptedAuthority(
    authority: PinIssueCommandAuthority,
    orderDeliveryId: number,
    leaseExpiresAt: Date,
    externalManager?: import('typeorm').EntityManager,
  ): Promise<boolean> {
    const mgr = externalManager ?? this.repository.manager;
    const result = await mgr
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({
        status: PinIssueCommandStatus.STARTED,
        resolution: null,
        leaseExpiresAt,
        stateEnteredAt: new Date(),
        autoresolveVersion: 1,
      })
      .where('id = :commandId', { commandId: authority.commandId })
      .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
      .andWhere('generation = :generation', { generation: authority.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
      .andWhere('status IN (:...reclaimableStatuses)', {
        reclaimableStatuses: [
          PinIssueCommandStatus.STARTED,
          PinIssueCommandStatus.RETRY_PENDING,
          PinIssueCommandStatus.RETRYING,
        ],
      })
      .andWhere('external_issue_count = 1')
      .andWhere(
        `NOT EXISTS (
           SELECT 1 FROM ssg_issue_log l WHERE l.order_delivery_id = :odId
           UNION ALL
           SELECT 1 FROM ssg_issue_log_ops_archive a WHERE a.order_delivery_id = :odId
         )`,
        { odId: orderDeliveryId },
      )
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM order_delivery_ssg_insert_state s
           WHERE s.order_delivery_id = :odId2 AND s.state IN ('ATTEMPTED','CONFIRMED'))`,
        { odId2: orderDeliveryId },
      )
      .andWhere(
        `EXISTS (SELECT 1 FROM order_delivery od
           WHERE od.id = :odId3 AND od.bar_code IS NULL
             AND od.personal_code IS NULL AND od.ssg_transaction_id IS NULL)`,
        { odId3: orderDeliveryId },
      )
      .execute();
    return result.affected === 1;
  }

  /**
   * §6-B-1 delivery claim 재획득.
   *
   * frozen command 의 delivery 는 `releaseStaleBatchClaims` 로 claimed_at = NULL 이 된 상태다.
   * 5분 미만 크래시 시 `mutation_claimed_at` 은 남아 있을 수 있으므로(①의 stale 조건 미충족),
   * claimed_at IS NULL + (mutation_claimed_at IS NULL OR mutation_claimed_at = :priorToken) 으로
   * 원자적 회수한다. priorToken 은 command 의 기존 deliveryClaimToken 이다.
   */
  async reacquireDeliveryClaim(
    authority: PinIssueCommandAuthority,
    orderDeliveryId: number,
    priorClaimToken?: string | null,
    externalManager?: import('typeorm').EntityManager,
  ): Promise<{ deliveryClaimToken: string } | null> {
    const now = new Date();
    const claimToken = now.toISOString();
    const claimDate = new Date(claimToken);

    const priorClaimDate = priorClaimToken ? new Date(priorClaimToken) : null;
    const validPrior =
      priorClaimDate && !Number.isNaN(priorClaimDate.getTime()) && priorClaimDate.toISOString() === priorClaimToken;

    const execute = async (manager: import('typeorm').EntityManager) => {
      const qb = manager
          .createQueryBuilder()
          .update(OrderDeliveryEntity)
          .set({ claimedAt: claimDate, mutationClaimedAt: claimDate })
          .where('id = :id', { id: orderDeliveryId })
          .andWhere('claimed_at IS NULL')
          .andWhere('status = :wait', { wait: 'WAIT' })
          .andWhere('destroyed_at IS NULL')
          .andWhere('discarded_at IS NULL')
          .andWhere('refunded_at IS NULL');

        if (validPrior) {
          qb.andWhere('(mutation_claimed_at IS NULL OR mutation_claimed_at = :priorMutation)', {
            priorMutation: priorClaimDate,
          });
        } else {
          qb.andWhere('mutation_claimed_at IS NULL');
        }

        const claimed = await qb.execute();
        if (claimed.affected !== 1) return null;

        const synced = await manager
          .createQueryBuilder()
          .update(PinIssueCommandEntity)
          .set({ deliveryClaimToken: claimToken })
          .where('id = :commandId', { commandId: authority.commandId })
          .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
          .andWhere('generation = :generation', { generation: authority.generation })
          .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
          .andWhere('status IN (:...allowedStatuses)', {
            allowedStatuses: [PinIssueCommandStatus.STARTED, PinIssueCommandStatus.RETRYING],
          })
          .execute();
        if (synced.affected !== 1) throw new PinIssueCommandClaimReacquireConflictError();

        return { deliveryClaimToken: claimToken };
      };

    if (externalManager) {
      try {
        return await execute(externalManager);
      } catch (error) {
        if (error instanceof PinIssueCommandClaimReacquireConflictError) return null;
        throw error;
      }
    }
    try {
      return await this.repository.manager.transaction(async (manager) => execute(manager));
    } catch (error) {
      if (error instanceof PinIssueCommandClaimReacquireConflictError) return null;
      throw error;
    }
  }

  /**
   * PIN 반영 + command 종결 + delivery claim 해제를 한 트랜잭션에서 수행.
   * sweep의 classify→claim재획득→apply 경로에서, lease 만료 경합 시 PIN만 저장되는
   * 문제를 방지한다. delivery claim CAS가 실패하면 PIN도 함께 롤백된다.
   */
  async markSucceededWithPinAfterDeliveryClaimRelease(
    authority: PinIssueCommandAuthority,
    orderDeliveryId: number,
    deliveryClaimToken: string | null,
    pin: {
      barCode: string;
      personalCode: string;
      ssgTransactionId: string;
      couponNum: string | null;
      expireAt: Date | null;
      encourageAt: Date | null;
      ssgEventId: number | null;
    },
  ): Promise<boolean> {
    if (!deliveryClaimToken) return false;

    const claimedAt = new Date(deliveryClaimToken);
    if (Number.isNaN(claimedAt.getTime()) || claimedAt.toISOString() !== deliveryClaimToken) return false;

    try {
      return await this.repository.manager.transaction(async (manager) => {
        const pinUpdate: Record<string, any> = {
          barCode: pin.barCode,
          personalCode: pin.personalCode,
          ssgTransactionId: pin.ssgTransactionId,
          couponNum: pin.couponNum,
          expireAt: pin.expireAt,
          encourageAt: pin.encourageAt,
        };
        if (pin.ssgEventId != null) {
          pinUpdate.ssgEventId = pin.ssgEventId;
        }
        const pinResult = await manager
          .createQueryBuilder()
          .update(OrderDeliveryEntity)
          .set(pinUpdate)
          .where('id = :id', { id: orderDeliveryId })
          .andWhere('status = :wait', { wait: 'WAIT' })
          .andWhere('refunded_at IS NULL')
          .andWhere('discarded_at IS NULL')
          .andWhere('destroyed_at IS NULL')
          .andWhere('claimed_at = :claimedAt', { claimedAt })
          .andWhere('mutation_claimed_at = :claimedAt', { claimedAt })
          .andWhere(
            'NOT EXISTS (SELECT 1 FROM order_delivery_refund r WHERE r.order_delivery_id = :id)',
          )
          .execute();
        if (pinResult.affected !== 1) throw new PinIssueCommandTransitionConflictError();

        const stateResult = await manager
          .createQueryBuilder()
          .update(OrderDeliverySsgInsertStateEntity)
          .set({ state: SsgInsertState.CONFIRMED })
          .where('order_delivery_id = :id', { id: orderDeliveryId })
          .andWhere('state = :prev', { prev: SsgInsertState.ATTEMPTED })
          .execute();
        if (stateResult.affected !== 1) {
          const alreadyConfirmed = await manager
            .createQueryBuilder()
            .from(OrderDeliverySsgInsertStateEntity, 's')
            .where('s.order_delivery_id = :id', { id: orderDeliveryId })
            .andWhere('s.state = :confirmed', { confirmed: SsgInsertState.CONFIRMED })
            .getCount();
          if (!alreadyConfirmed) {
            throw new PinIssueCommandTransitionConflictError();
          }
          this.logger.warn(`[PIN_CMD] insert-state already CONFIRMED orderDeliveryId=${orderDeliveryId}`);
        }

        const released = await manager
          .createQueryBuilder()
          .update(OrderDeliveryEntity)
          .set({ claimedAt: null, mutationClaimedAt: null })
          .where('id = :id', { id: orderDeliveryId })
          .andWhere('claimed_at = :claimedAt', { claimedAt })
          .andWhere('mutation_claimed_at = :claimedAt', { claimedAt })
          .execute();
        if (released.affected !== 1) throw new PinIssueCommandTransitionConflictError();

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
class PinIssueCommandClaimReacquireConflictError extends Error {}
