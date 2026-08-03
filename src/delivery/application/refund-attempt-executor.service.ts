import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import { DualApprovalEntity } from '../../entity/dual.approval.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { RefundAttemptEntity } from '../../entity/refund.attempt.entity';
import {
  StaleExternalResponseEntity,
  StaleMismatchReason,
  StaleStateMachine,
} from '../../entity/stale.external.response.entity';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DualApprovalStatus } from '../interface/dual.approval.status';
import {
  DeliveryExclusiveOp,
  DeliverySlotFailureCode,
  DeliveryWorkflowStatus,
  OpsReviewReason,
} from '../interface/delivery.workflow.status';
import { RefundAttemptStatus, RefundEntryPath, RefundScope } from '../interface/refund.attempt.status';
import {
  DeliverySlot,
  DeliveryWorkflowSlotService,
  SLOT_LEASE_MS,
  SlotApprovalBinding,
} from './delivery-workflow-slot.service';
import { RefundExecutionFencing } from './delivery-cutover-guard.service';

/**
 * 외부 환불 콜백의 hard timeout. 슬롯 리스의 절반 이하로 잡는다(§6.1 "외부 호출 타임아웃은 리스의 절반 이하").
 *
 * 이 값은 **정지 증거가 아니라 수렴 장치**다. JS Promise 는 취소되지 않으므로 timeout 이후에도
 * 콜백은 계속 살아 있을 수 있다. 그래서 시간 경과도, timeout 이 만들어낸 상태(`UNKNOWN`/`RECONCILING`)도
 * "외부 실행이 끝났다" 는 근거로 쓰지 않는다(`priorExecutionQuiesced` 참고). 정지 사실은 살아남은
 * promise 를 끝까지 관측해 따로 기록한다(`observeLateSettlement`). 살아남은 콜백의 부작용은
 * ledger claim 의 3중 fencing + attempt 행 잠금(`RefundLedgerService`)이 차단한다.
 */
export const REFUND_EXECUTION_TIMEOUT_MS = Math.floor(SLOT_LEASE_MS / 2);

/** timeout 으로 종결된 UNKNOWN 의 사유 코드(운영 구분용). */
export const REFUND_EXECUTION_TIMEOUT_REASON = 'REFUND_EXECUTION_TIMEOUT';

/**
 * `callWithTimeout` 이 던지는 timeout 전용 오류.
 *
 * timeout 판별은 **타입**으로 한다. 메시지 문자열로 비교하면 외부 콜백이 우연히 같은 문자열로
 * reject 했을 때 이미 종료된 콜백을 in-flight 로 오인해, 정지 사실을 settle 과 같은 트랜잭션에
 * 남기지 못하고 재조정·SLA 수동종결로 밀어 버린다. 콜백 메시지는 우리가 통제하지 못한다.
 */
export class RefundExecutionTimeoutError extends Error {
  constructor() {
    super(REFUND_EXECUTION_TIMEOUT_REASON);
    this.name = 'RefundExecutionTimeoutError';
  }
}

export type RefundExecutionOutcome =
  | { status: RefundAttemptStatus.SUCCEEDED }
  | { status: RefundAttemptStatus.FAILED | RefundAttemptStatus.UNKNOWN; reason: string };

export interface ExecuteRefundContext extends RefundExecutionFencing {
  externalIdempotencyKey: string;
}

export interface ExecuteRefundInput {
  orderDeliveryId: number;
  amount: number;
  scope: RefundScope;
  externalIdempotencyKey: string;
  approval?: SlotApprovalBinding;
  execute: (context: ExecuteRefundContext) => Promise<RefundExecutionOutcome>;
  bindAttempt?: (attempt: RefundAttemptEntity, manager: EntityManager) => Promise<void>;
  now?: Date;
}

export interface ExecuteRefundResult {
  attemptId: string;
  status: RefundAttemptStatus;
}

export interface ReconcileRefundInput {
  attemptId: string;
  orderDeliveryId: number;
  amount: number;
  scope: RefundScope;
  /**
   * 외부 실행 여부 증거 조회. `null` 은 "아직 확정 불가"(RECONCILING 유지)다.
   *
   * workflow 종결 상태는 호출자가 지정하지 않는다 — attempt 의 `entryPath` 로 executor 가 결정한다
   * (§5.4 경로 A/B, §10 불변식 ①).
   */
  inspect: (
    attempt: RefundAttemptEntity,
  ) => Promise<
    { status: RefundAttemptStatus.SUCCEEDED } | { status: RefundAttemptStatus.FAILED; reason: string } | null
  >;
}

interface ClaimedRefund {
  attempt: RefundAttemptEntity;
  slot: DeliverySlot;
  entryPath: RefundEntryPath;
}

/** RECONCILE 슬롯으로 회수한 attempt + 직전 실행 스냅샷(정지 판정 근거). */
interface ClaimedReconcile {
  attempt: RefundAttemptEntity;
  slot: DeliverySlot;
  priorStatus: RefundAttemptStatus;
}

type ReconcileClaim = ClaimedReconcile | { settledStatus: RefundAttemptStatus };

/**
 * 컷오버 환불 실행기. REFUND 슬롯과 refund_attempt 를 먼저 durable 하게 만든 뒤 외부 환불을
 * 트랜잭션 밖에서 실행하고, 응답은 ownerToken + generation + workflowVersion 3중 fencing 으로 반영한다.
 */
@Injectable()
export class RefundAttemptExecutorService {
  private readonly logger = new Logger(RefundAttemptExecutorService.name);

  constructor(
    @InjectRepository(RefundAttemptEntity)
    private readonly attemptRepository: Repository<RefundAttemptEntity>,
    private readonly slotService: DeliveryWorkflowSlotService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cryptoCipher: CryptoCipher,
  ) {}

  async latestStatus(orderDeliveryId: number): Promise<RefundAttemptStatus | null> {
    const attempt = await this.attemptRepository.findOne({
      select: ['status'],
      where: { orderDeliveryId },
      order: { id: 'DESC' },
    });
    return attempt?.status ?? null;
  }

  async findBoundAttempt(input: {
    attemptId: string;
    orderDeliveryId: number;
    amount: number;
    scope: RefundScope;
  }): Promise<RefundAttemptEntity | null> {
    return await this.attemptRepository.findOne({
      where: {
        id: input.attemptId,
        orderDeliveryId: input.orderDeliveryId,
        amount: input.amount,
        scope: input.scope,
      },
    });
  }

  async reconcile(input: ReconcileRefundInput): Promise<RefundAttemptStatus | null> {
    const now = new Date();
    const claimed = await this.dataSource.transaction<ReconcileClaim | null>(async (manager) => {
      const attempt = await manager.getRepository(RefundAttemptEntity).findOne({
        where: {
          id: input.attemptId,
          orderDeliveryId: input.orderDeliveryId,
          amount: input.amount,
          scope: input.scope,
        },
        // 직전 실행의 markSubmitting/settle 과 직렬화한다. 잠그지 않으면 "CLAIMED 로 읽었는데
        // 실제로는 이미 SUBMITTING" 처럼 정지 판정의 전제가 뒤집힌다.
        lock: { mode: 'pessimistic_write' },
      });
      if (!attempt) {
        throw new ConflictException({ code: 'REFUND_ATTEMPT_BINDING_MISMATCH' });
      }
      if (attempt.status === RefundAttemptStatus.SUCCEEDED || attempt.status === RefundAttemptStatus.FAILED) {
        return { settledStatus: attempt.status };
      }

      const priorStatus = attempt.status;

      const acquired = await this.slotService.acquire(
        {
          orderDeliveryId: input.orderDeliveryId,
          op: DeliveryExclusiveOp.RECONCILE,
          now,
        },
        manager,
      );
      if (!acquired.acquired) {
        return null;
      }

      const nextGeneration = (BigInt(attempt.generation) + 1n).toString();
      const claimedResult = await manager
        .getRepository(RefundAttemptEntity)
        .createQueryBuilder()
        .update(RefundAttemptEntity)
        .set({
          status: RefundAttemptStatus.RECONCILING,
          ownerToken: acquired.slot.ownerToken,
          generation: nextGeneration,
          workflowVersion: acquired.slot.workflowVersion,
          stateEnteredAt: now,
        })
        .where('id = :id', { id: attempt.id })
        .andWhere('generation = :generation', { generation: attempt.generation })
        .andWhere('status IN (:...statuses)', {
          statuses: [
            RefundAttemptStatus.CLAIMED,
            RefundAttemptStatus.SUBMITTING,
            RefundAttemptStatus.RECONCILING,
            RefundAttemptStatus.UNKNOWN,
          ],
        })
        .execute();
      if (!claimedResult.affected) {
        throw this.staleExecution(attempt.id);
      }

      attempt.status = RefundAttemptStatus.RECONCILING;
      attempt.ownerToken = acquired.slot.ownerToken;
      attempt.generation = nextGeneration;
      attempt.workflowVersion = acquired.slot.workflowVersion;
      return { attempt, slot: acquired.slot, priorStatus };
    });

    if (!claimed) {
      return null;
    }
    if ('settledStatus' in claimed) {
      return claimed.settledStatus;
    }

    let inspected:
      | { status: RefundAttemptStatus.SUCCEEDED }
      | { status: RefundAttemptStatus.FAILED; reason: string }
      | null;
    try {
      inspected = await input.inspect(claimed.attempt);
    } catch (error) {
      await this.slotService.release(claimed.slot);
      throw error;
    }
    if (!inspected) {
      await this.slotService.release(claimed.slot);
      return RefundAttemptStatus.RECONCILING;
    }

    // 미실행(FAILED) 확정은 직전 실행이 끝난 뒤에만 가능하다. 아직 in-flight 일 수 있으면
    // RECONCILING 을 유지하고 다음 sweep 으로 넘긴다(실제 환불 + attempt FAILED 동시 성립 차단).
    if (inspected.status === RefundAttemptStatus.FAILED && !(await this.priorExecutionQuiesced(claimed))) {
      this.logger.warn(
        `[REFUND_ATTEMPT] 직전 실행 미정지로 미실행 확정을 보류한다. refundAttemptId=${claimed.attempt.id}`,
      );
      await this.slotService.release(claimed.slot);
      return RefundAttemptStatus.RECONCILING;
    }

    const outcome = inspected;
    await this.dataSource.transaction(async (manager) => {
      const settledAt = new Date();
      const attemptResult = await manager
        .getRepository(RefundAttemptEntity)
        .createQueryBuilder()
        .update(RefundAttemptEntity)
        .set({
          status: outcome.status,
          failureReason: outcome.status === RefundAttemptStatus.FAILED ? outcome.reason.slice(0, 500) : null,
          stateEnteredAt: settledAt,
          resolvedAt: settledAt,
        })
        .where('id = :id', { id: claimed.attempt.id })
        .andWhere('status = :reconciling', {
          reconciling: RefundAttemptStatus.RECONCILING,
        })
        .andWhere('owner_token = :ownerToken', {
          ownerToken: claimed.slot.ownerToken,
        })
        .andWhere('generation = :generation', {
          generation: claimed.attempt.generation,
        })
        .andWhere('workflow_version = :workflowVersion', {
          workflowVersion: claimed.slot.workflowVersion,
        })
        .execute();
      if (!attemptResult.affected) {
        throw this.staleExecution(claimed.attempt.id);
      }

      // 경로별 전이는 실행 경로(settle)와 같은 규칙을 쓴다. 경로 A 성공만
      // RESOLVED_MANUALLY_REFUNDED + settled_refund_attempt_id 로 종결한다(§10 불변식 ①).
      //
      // 현재 상태를 함께 읽어 넘기는 것은 경로 B 의 REFUND_UNKNOWN 승격을 되돌릴지 판정하기 위해서다.
      // 읽은 뒤 상태가 바뀌면 아래 UPDATE 가 workflow_version fencing 으로 affected=0 이 되므로 안전하다.
      const currentWorkflow = await manager.getRepository(DeliveryWorkflowEntity).findOne({
        select: ['workflowStatus', 'opsReviewReason'],
        where: { orderDeliveryId: input.orderDeliveryId },
      });
      const workflowResult = await manager
        .getRepository(DeliveryWorkflowEntity)
        .createQueryBuilder()
        .update(DeliveryWorkflowEntity)
        .set(this.workflowSettlement(claimed.attempt, outcome, settledAt, currentWorkflow))
        .where('order_delivery_id = :orderDeliveryId', {
          orderDeliveryId: input.orderDeliveryId,
        })
        .andWhere('active_exclusive_op = :op', {
          op: DeliveryExclusiveOp.RECONCILE,
        })
        .andWhere('exclusive_owner_token = :ownerToken', {
          ownerToken: claimed.slot.ownerToken,
        })
        .andWhere('workflow_version = :workflowVersion', {
          workflowVersion: claimed.slot.workflowVersion,
        })
        .execute();
      if (!workflowResult.affected) {
        throw this.staleExecution(claimed.attempt.id);
      }

      if (outcome.status === RefundAttemptStatus.SUCCEEDED) {
        await manager
          .getRepository(OrderDeliveryEntity)
          .update({ id: input.orderDeliveryId }, { refundedAt: settledAt });
      }
    });

    return outcome.status;
  }

  /**
   * 직전 실행이 확실히 종료됐는지 판정한다(§6.1 fencing 한계 대응).
   *
   * fencing 은 DB 반영만 막고 진행 중인 외부 환불은 취소하지 못한다. "원장이 없다" 는 1회 관찰만으로
   * FAILED 를 확정하면, 아직 커밋 전이던 직전 실행이 뒤늦게 실제 환불을 커밋했을 때
   * attempt 만 FAILED 가 되어 신규 attempt 가 열린다(이중 환불).
   *
   * **시간 경과도, timeout 이 만든 상태도 근거가 아니다.** hard timeout 은 워커를 대기에서 꺼낼 뿐
   * 콜백을 취소하지 못하므로, timeout 으로 찍힌 `UNKNOWN`/`RECONCILING` 은 SUBMITTING 보다도 약한
   * 표식이다(콜백은 여전히 실행 중일 수 있는데 상태만 앞서 나간 것). 같은 이유로 stale 감사 행도
   * 단독 근거가 못 된다 — heartbeat 상실 + timeout 이 겹치면 콜백이 살아 있는 채로 stale 행이 남는다.
   *
   * 근거로 인정하는 커밋된 DB 사실은 둘뿐이다.
   *   ① 직전 상태가 `CLAIMED` — 재조정이 세대를 올린 순간 `markSubmitting` 이 영구 실패하므로
   *      외부 호출이 시작되지 않았음이 확정된다(상태만으로 성립하는 유일한 근거).
   *   ② `execution_quiesced_generation` 이 기록돼 있다 — 콜백을 실제로 관측한 프로세스가
   *      종료를 커밋했다(정상 종료는 settle/stale 트랜잭션, timeout 종료는 `observeLateSettlement`).
   *
   * 둘 다 없으면 확정하지 않고 RECONCILING 을 유지한다. 프로세스가 timeout 구간에서 죽으면 ②는
   * 끝내 남지 않으므로 자동 수렴하지 않고 재조정 SLA 초과 → `UNKNOWN` → 운영 수동 종결로 간다(§5.4).
   * 이중 환불보다 운영 종결이 싸다.
   */
  private async priorExecutionQuiesced(claimed: ClaimedReconcile): Promise<boolean> {
    if (claimed.priorStatus === RefundAttemptStatus.CLAIMED) {
      return true;
    }

    // 스냅샷이 아니라 지금 다시 읽는다. 재조정 슬롯을 잡은 뒤에 콜백이 끝났을 수 있고,
    // 그 사실을 이번 sweep 에서 바로 쓰면 한 주기 먼저 수렴한다.
    const current = await this.attemptRepository.findOne({
      select: ['executionQuiescedGeneration'],
      where: { id: claimed.attempt.id },
    });
    return !!current?.executionQuiescedGeneration;
  }

  /**
   * 외부 환불 콜백이 실제로 종료됐다는 사실을 기록한다(§6.1).
   *
   * 상태 전이가 아니라 **append-only 사실**이므로 소유권·세대·workflow 버전으로 fencing 하지 않는다.
   * fencing 을 잃은 워커가 관측한 종료도 종료다 — 오히려 그 경우가 재조정이 가장 필요로 하는 근거다.
   * 늦게 도착한 낮은 세대가 높은 세대 기록을 덮지 않도록 단조 증가 조건만 건다.
   */
  private async markExecutionQuiesced(attemptId: string, generation: string, manager?: EntityManager): Promise<void> {
    const repository = manager ? manager.getRepository(RefundAttemptEntity) : this.attemptRepository;
    await repository
      .createQueryBuilder()
      .update(RefundAttemptEntity)
      .set({ executionQuiescedGeneration: generation })
      .where('id = :id', { id: attemptId })
      .andWhere('(execution_quiesced_generation IS NULL OR execution_quiesced_generation < :generation)', {
        generation,
      })
      .execute();
  }

  /**
   * timeout 으로 손을 뗀 콜백의 **실제 종료 시점**을 끝까지 관측해 정지 사실을 남긴다.
   *
   * timeout 은 워커의 대기만 끊을 뿐 promise 를 취소하지 못한다. 이 관측이 없으면 정지 근거가
   * 영영 생기지 않아 재조정이 미실행(FAILED)을 확정할 수 없고, 정상 실패 건까지 운영 종결로 밀린다.
   * 기록 실패는 로그만 남긴다 — 근거가 없으면 확정을 안 하는 쪽이라 fail-safe 다.
   * 이 관측은 timeout 이후 unhandled rejection 을 봉인하는 역할도 겸한다.
   */
  private observeLateSettlement(claimed: ClaimedRefund, pending: Promise<RefundExecutionOutcome>): void {
    void pending.then(
      () => this.recordLateSettlement(claimed),
      () => this.recordLateSettlement(claimed),
    );
  }

  private async recordLateSettlement(claimed: ClaimedRefund): Promise<void> {
    try {
      await this.markExecutionQuiesced(claimed.attempt.id, claimed.attempt.generation);
      this.logger.warn(
        `[REFUND_ATTEMPT] timeout 이후 외부 콜백이 뒤늦게 종료됐다. refundAttemptId=${claimed.attempt.id}`,
      );
    } catch (error) {
      this.logger.error(
        `[REFUND_ATTEMPT] 콜백 종료 사실 기록 실패. refundAttemptId=${claimed.attempt.id}: ${this.safeMessage(error)}`,
      );
    }
  }

  async execute(input: ExecuteRefundInput): Promise<ExecuteRefundResult> {
    const now = input.now ?? new Date();
    const claimed = await this.claim(input, now);
    const context = this.contextOf(claimed);

    const submitting = await this.markSubmitting(claimed, now);
    if (!submitting) {
      throw this.staleExecution(claimed.attempt.id);
    }

    let heartbeatLost = false;
    let heartbeatInFlight = Promise.resolve();
    const verifyHeartbeat = async (): Promise<void> => {
      try {
        if (!(await this.slotService.heartbeat(claimed.slot))) {
          heartbeatLost = true;
          this.logger.warn(`[REFUND_ATTEMPT] 슬롯 소유권 상실. refundAttemptId=${claimed.attempt.id}`);
        }
      } catch (error) {
        heartbeatLost = true;
        this.logger.error(
          `[REFUND_ATTEMPT] 슬롯 heartbeat 실패. refundAttemptId=${claimed.attempt.id}: ${this.safeMessage(error)}`,
        );
      }
    };
    const heartbeat = setInterval(
      () => {
        heartbeatInFlight = heartbeatInFlight.then(verifyHeartbeat);
      },
      Math.floor(SLOT_LEASE_MS / 3),
    );
    heartbeat.unref();

    // 콜백 참조를 붙잡아 둔다. timeout 으로 손을 떼도 promise 는 살아 있고,
    // 그 실제 종료를 관측해야 정지 사실을 남길 수 있다(§6.1 `priorExecutionQuiesced` ②).
    const pending = Promise.resolve().then(() => input.execute(context));

    let outcome: RefundExecutionOutcome;
    // 콜백이 반환/예외로 끝났는지. timeout 만 예외다 — 그때는 콜백이 아직 실행 중일 수 있다.
    let executionQuiesced = true;
    try {
      outcome = await this.callWithTimeout(pending);
    } catch (error) {
      // 콜백이 던진 오류는 그 자체로 종료 증거다. timeout 만 예외이고, 그 판별은 우리가 던진
      // 타입으로만 한다 — 콜백이 우연히 같은 메시지로 reject 해도 종료를 timeout 으로 오인하지 않는다.
      executionQuiesced = !(error instanceof RefundExecutionTimeoutError);
      outcome = {
        status: RefundAttemptStatus.UNKNOWN,
        reason: this.safeReason(error),
      };
    } finally {
      clearInterval(heartbeat);
      await heartbeatInFlight;
      await verifyHeartbeat();
    }

    if (!executionQuiesced) {
      this.observeLateSettlement(claimed, pending);
    }

    if (heartbeatLost) {
      await this.recordStaleAndReconcile(claimed, outcome, new Date(), executionQuiesced, true);
      throw this.staleExecution(claimed.attempt.id);
    }

    try {
      const settled = await this.settle(claimed, outcome, new Date(), executionQuiesced);
      if (!settled) {
        throw this.staleExecution(claimed.attempt.id);
      }
    } catch (error) {
      await this.recordStaleAndReconcile(claimed, outcome, new Date(), executionQuiesced);
      throw error;
    }

    return { attemptId: claimed.attempt.id, status: outcome.status };
  }

  private async claim(input: ExecuteRefundInput, now: Date): Promise<ClaimedRefund> {
    return await this.dataSource.transaction(async (manager) => {
      const acquired = await this.slotService.acquire(
        {
          orderDeliveryId: input.orderDeliveryId,
          op: DeliveryExclusiveOp.REFUND,
          approval: input.approval,
          now,
        },
        manager,
      );
      if (!acquired.acquired) {
        throw new ConflictException({
          code: acquired.code,
          requiresDualApproval: acquired.requiresDualApproval,
          workflowStatus: acquired.workflowStatus,
        });
      }

      const entryPath = input.approval ? RefundEntryPath.A : RefundEntryPath.B;
      if (entryPath === RefundEntryPath.A) {
        await this.assertApprovalPayload(manager, input);
      }

      // 경로 B 는 UNKNOWN 시 workflow 를 OPS_REVIEW_REQUIRED 로 올린다. 재조정으로 결과가 확정되면
      // 되돌려야 하므로, 되돌릴 기준(환불 시작 시점 상태)을 attempt 에 함께 남긴다(§5.4).
      const entryWorkflow = await manager.getRepository(DeliveryWorkflowEntity).findOne({
        select: ['workflowStatus'],
        where: { orderDeliveryId: input.orderDeliveryId },
      });

      const repo = manager.getRepository(RefundAttemptEntity);
      const attempt = await repo.save(
        repo.create({
          orderDeliveryId: input.orderDeliveryId,
          status: RefundAttemptStatus.CLAIMED,
          entryPath,
          amount: input.amount,
          scope: input.scope,
          externalIdempotencyKey: input.externalIdempotencyKey,
          ownerToken: acquired.slot.ownerToken,
          generation: '1',
          workflowVersion: acquired.slot.workflowVersion,
          approvalId: input.approval?.approvalId ?? null,
          createdByOp: DeliveryExclusiveOp.REFUND,
          createdWorkflowVersion: acquired.slot.workflowVersion,
          entryWorkflowStatus: entryWorkflow?.workflowStatus ?? null,
          stateEnteredAt: now,
          failureReason: null,
          resolvedAt: null,
        }),
      );
      if (input.bindAttempt) {
        await input.bindAttempt(attempt, manager);
      }

      return { attempt, slot: acquired.slot, entryPath };
    });
  }

  private async assertApprovalPayload(manager: EntityManager, input: ExecuteRefundInput): Promise<void> {
    const approval = await manager.getRepository(DualApprovalEntity).findOne({
      where: {
        id: input.approval!.approvalId,
        orderDeliveryId: input.orderDeliveryId,
        op: DeliveryExclusiveOp.REFUND,
        status: DualApprovalStatus.APPROVED,
      },
    });
    if (
      !approval ||
      approval.payloadHash !== input.approval!.payloadHash ||
      approval.boundWorkflowVersion !== input.approval!.boundWorkflowVersion ||
      approval.amount !== input.amount ||
      approval.scope !== input.scope ||
      approval.externalIdempotencyKey !== input.externalIdempotencyKey
    ) {
      throw new ConflictException({ code: DeliverySlotFailureCode.DELIVERY_OPERATION_NOT_ALLOWED });
    }
  }

  private async markSubmitting(claimed: ClaimedRefund, now: Date): Promise<boolean> {
    const result = await this.attemptRepository
      .createQueryBuilder()
      .update(RefundAttemptEntity)
      .set({ status: RefundAttemptStatus.SUBMITTING, stateEnteredAt: now })
      .where('id = :id', { id: claimed.attempt.id })
      .andWhere('status = :claimed', { claimed: RefundAttemptStatus.CLAIMED })
      .andWhere('owner_token = :ownerToken', { ownerToken: claimed.slot.ownerToken })
      .andWhere('generation = :generation', { generation: claimed.attempt.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: claimed.slot.workflowVersion })
      .andWhere(
        `EXISTS (SELECT 1 FROM delivery_workflow w
                  WHERE w.order_delivery_id = refund_attempt.order_delivery_id
                    AND w.active_exclusive_op = :refundOp
                    AND w.exclusive_owner_token = :ownerToken
                    AND w.workflow_version = :workflowVersion
                    AND w.exclusive_lease_expires_at > :now)`,
        { refundOp: DeliveryExclusiveOp.REFUND, now },
      )
      .execute();
    return !!result.affected;
  }

  private async settle(
    claimed: ClaimedRefund,
    outcome: RefundExecutionOutcome,
    now: Date,
    executionQuiesced: boolean,
  ): Promise<boolean> {
    return await this.dataSource.transaction(async (manager) => {
      // 상태 반영이 fencing 으로 튕겨도 정지 사실은 남긴다(재조정이 쓰는 유일한 근거).
      if (executionQuiesced) {
        await this.markExecutionQuiesced(claimed.attempt.id, claimed.attempt.generation, manager);
      }

      const attemptResult = await manager
        .getRepository(RefundAttemptEntity)
        .createQueryBuilder()
        .update(RefundAttemptEntity)
        .set({
          status: outcome.status,
          failureReason: outcome.status === RefundAttemptStatus.SUCCEEDED ? null : outcome.reason.slice(0, 500),
          stateEnteredAt: now,
          resolvedAt: outcome.status === RefundAttemptStatus.UNKNOWN ? null : now,
        })
        .where('id = :id', { id: claimed.attempt.id })
        .andWhere('status = :submitting', { submitting: RefundAttemptStatus.SUBMITTING })
        .andWhere('owner_token = :ownerToken', { ownerToken: claimed.slot.ownerToken })
        .andWhere('generation = :generation', { generation: claimed.attempt.generation })
        .andWhere('workflow_version = :workflowVersion', { workflowVersion: claimed.slot.workflowVersion })
        .execute();
      if (!attemptResult.affected) {
        return false;
      }

      const workflowSet = this.workflowSettlement(claimed.attempt, outcome, now);
      const workflowResult = await manager
        .getRepository(DeliveryWorkflowEntity)
        .createQueryBuilder()
        .update(DeliveryWorkflowEntity)
        .set(workflowSet)
        .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId: claimed.slot.orderDeliveryId })
        .andWhere('active_exclusive_op = :op', { op: DeliveryExclusiveOp.REFUND })
        .andWhere('exclusive_owner_token = :ownerToken', { ownerToken: claimed.slot.ownerToken })
        .andWhere('workflow_version = :workflowVersion', { workflowVersion: claimed.slot.workflowVersion })
        .execute();
      if (!workflowResult.affected) {
        throw this.staleExecution(claimed.attempt.id);
      }

      if (outcome.status === RefundAttemptStatus.SUCCEEDED) {
        await manager
          .getRepository(OrderDeliveryEntity)
          .createQueryBuilder()
          .update(OrderDeliveryEntity)
          .set({ refundedAt: now })
          .where('id = :orderDeliveryId', { orderDeliveryId: claimed.slot.orderDeliveryId })
          .execute();
      }
      return true;
    });
  }

  /**
   * 환불 결과의 workflow 전이(§5.4 경로 A/B). 실행(settle)과 재조정(reconcile)이 같은 규칙을 쓴다.
   *
   * - 경로 A 성공: `RESOLVED_MANUALLY_REFUNDED` + `settled_refund_attempt_id` 원자 기록(§10 불변식 ①).
   * - 경로 B 성공: 기존 종결 상태 유지 + `refunded_at`·`refund_status` 표식만(재전이 금지).
   * - 경로 B UNKNOWN: `OPS_REVIEW_REQUIRED` 승격(`REFUND_UNKNOWN`).
   * - 재조정으로 결과가 확정되면 그 승격을 **되돌린다**(`current` 전달 시). 우리가 올린 에스컬레이션은
   *   우리가 내린다 — 성공인데 "환불 결과 불명"이 남거나, 미실행 확정인데 DUAL 없이는 재시도할 수
   *   없는 상태로 묶이는 것을 막는다.
   *
   * `current` 는 재조정 경로에서만 넘긴다. 실행(settle) 시점의 경로 B 는 종결 상태에서 진입하므로
   * `OPS_REVIEW_REQUIRED` 일 수 없다(그 승격은 이 호출이 만들어낸다).
   */
  private workflowSettlement(
    attempt: Pick<RefundAttemptEntity, 'id' | 'entryPath' | 'entryWorkflowStatus'>,
    outcome: RefundExecutionOutcome,
    now: Date,
    current?: Pick<DeliveryWorkflowEntity, 'workflowStatus' | 'opsReviewReason'> | null,
  ): Partial<DeliveryWorkflowEntity> | Record<string, unknown> {
    const common: Partial<DeliveryWorkflowEntity> | Record<string, unknown> = {
      activeExclusiveOp: null,
      exclusiveOwnerToken: null,
      exclusiveLeaseExpiresAt: null,
      refundStatus: outcome.status,
      workflowVersion: () => 'workflow_version + 1',
    };
    if (outcome.status === RefundAttemptStatus.SUCCEEDED) {
      return {
        ...common,
        refundedAt: now,
        ...(attempt.entryPath === RefundEntryPath.A
          ? {
              workflowStatus: DeliveryWorkflowStatus.RESOLVED_MANUALLY_REFUNDED,
              settledRefundAttemptId: attempt.id,
              stateEnteredAt: now,
            }
          : this.refundUnknownRollback(attempt, current, now)),
      };
    }

    if (outcome.status === RefundAttemptStatus.FAILED) {
      return {
        ...common,
        ...(attempt.entryPath === RefundEntryPath.B ? this.refundUnknownRollback(attempt, current, now) : {}),
      };
    }

    return {
      ...common,
      ...(attempt.entryPath === RefundEntryPath.B
        ? {
            workflowStatus: DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
            stateEnteredAt: now,
            opsEscalatedAt: now,
            opsReviewReason: OpsReviewReason.REFUND_UNKNOWN,
          }
        : {}),
    };
  }

  /**
   * 경로 B 의 `REFUND_UNKNOWN` 승격 해제분.
   *
   * **우리 승격일 때만** 되돌린다. 운영자가 이미 `OPS_RESOLVE` 로 종결했거나(`RESOLVED_MANUALLY_*`)
   * 다른 사유로 에스컬레이션된 건은 건드리지 않는다 — 수동 종결은 불변 override 다(§7.1).
   */
  private refundUnknownRollback(
    attempt: Pick<RefundAttemptEntity, 'entryWorkflowStatus'>,
    current: Pick<DeliveryWorkflowEntity, 'workflowStatus' | 'opsReviewReason'> | null | undefined,
    now: Date,
  ): Partial<DeliveryWorkflowEntity> | Record<string, unknown> {
    if (
      !attempt.entryWorkflowStatus ||
      current?.workflowStatus !== DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED ||
      current.opsReviewReason !== OpsReviewReason.REFUND_UNKNOWN
    ) {
      return {};
    }
    return {
      workflowStatus: attempt.entryWorkflowStatus,
      stateEnteredAt: now,
      opsEscalatedAt: null,
      opsReviewReason: null,
    };
  }

  private async recordStaleAndReconcile(
    claimed: ClaimedRefund,
    outcome: RefundExecutionOutcome,
    now: Date,
    executionQuiesced: boolean,
    heartbeatError = false,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // stale 행은 "이 워커가 물러났다" 는 사실일 뿐 콜백 종료 근거가 아니다. 종료 사실은 따로 남긴다.
      if (executionQuiesced) {
        await this.markExecutionQuiesced(claimed.attempt.id, claimed.attempt.generation, manager);
      }

      const currentAttempt = await manager.getRepository(RefundAttemptEntity).findOne({
        select: ['ownerToken', 'generation', 'workflowVersion'],
        where: { id: claimed.attempt.id },
      });
      const currentWorkflow = await manager.getRepository(DeliveryWorkflowEntity).findOne({
        select: ['exclusiveOwnerToken', 'workflowVersion'],
        where: { orderDeliveryId: claimed.slot.orderDeliveryId },
      });
      const mismatchReason = this.mismatchReason(claimed, currentAttempt, currentWorkflow, heartbeatError);

      const staleRepo = manager.getRepository(StaleExternalResponseEntity);
      await staleRepo.save(
        staleRepo.create({
          orderDeliveryId: claimed.slot.orderDeliveryId,
          stateMachine: StaleStateMachine.REFUND,
          targetKey: claimed.attempt.id,
          op: DeliveryExclusiveOp.REFUND,
          ownerToken: claimed.slot.ownerToken,
          generation: claimed.attempt.generation,
          workflowVersion: claimed.slot.workflowVersion,
          mismatchReason,
          responseBodyEnc: this.cryptoCipher.encryptJson(outcome),
        }),
      );

      await manager
        .getRepository(RefundAttemptEntity)
        .createQueryBuilder()
        .update(RefundAttemptEntity)
        .set({ status: RefundAttemptStatus.RECONCILING, stateEnteredAt: now })
        .where('id = :id', { id: claimed.attempt.id })
        .andWhere('status IN (:...statuses)', {
          statuses: [RefundAttemptStatus.CLAIMED, RefundAttemptStatus.SUBMITTING],
        })
        .andWhere('owner_token = :ownerToken', { ownerToken: claimed.slot.ownerToken })
        .andWhere('generation = :generation', { generation: claimed.attempt.generation })
        .andWhere('workflow_version = :workflowVersion', { workflowVersion: claimed.slot.workflowVersion })
        .execute();

      await manager
        .getRepository(DeliveryWorkflowEntity)
        .createQueryBuilder()
        .update(DeliveryWorkflowEntity)
        .set({
          activeExclusiveOp: null,
          exclusiveOwnerToken: null,
          exclusiveLeaseExpiresAt: null,
        })
        .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId: claimed.slot.orderDeliveryId })
        .andWhere('active_exclusive_op = :op', { op: DeliveryExclusiveOp.REFUND })
        .andWhere('exclusive_owner_token = :ownerToken', { ownerToken: claimed.slot.ownerToken })
        .andWhere('workflow_version = :workflowVersion', { workflowVersion: claimed.slot.workflowVersion })
        .execute();
    });
  }

  private mismatchReason(
    claimed: ClaimedRefund,
    currentAttempt: Pick<RefundAttemptEntity, 'ownerToken' | 'generation' | 'workflowVersion'> | null,
    currentWorkflow: Pick<DeliveryWorkflowEntity, 'exclusiveOwnerToken' | 'workflowVersion'> | null,
    heartbeatError = false,
  ): StaleMismatchReason {
    const ownerMismatch =
      currentAttempt?.ownerToken !== claimed.slot.ownerToken ||
      currentWorkflow?.exclusiveOwnerToken !== claimed.slot.ownerToken;
    const generationMismatch = currentAttempt?.generation !== claimed.attempt.generation;
    const versionMismatch =
      currentAttempt?.workflowVersion !== claimed.slot.workflowVersion ||
      currentWorkflow?.workflowVersion !== claimed.slot.workflowVersion;
    const mismatchCount = Number(ownerMismatch) + Number(generationMismatch) + Number(versionMismatch);

    if (mismatchCount === 0 && heartbeatError) {
      return StaleMismatchReason.HEARTBEAT_ERROR;
    }
    if (mismatchCount !== 1) {
      return StaleMismatchReason.MULTIPLE;
    }
    if (ownerMismatch) {
      return StaleMismatchReason.OWNER_TOKEN;
    }
    if (generationMismatch) {
      return StaleMismatchReason.GENERATION;
    }
    return StaleMismatchReason.WORKFLOW_VERSION;
  }

  private contextOf(claimed: ClaimedRefund): ExecuteRefundContext {
    return {
      refundAttemptId: claimed.attempt.id,
      ownerToken: claimed.slot.ownerToken,
      generation: claimed.attempt.generation,
      workflowVersion: claimed.slot.workflowVersion,
      externalIdempotencyKey: claimed.attempt.externalIdempotencyKey,
    };
  }

  private safeReason(error: unknown): string {
    this.logger.error(`[REFUND_ATTEMPT] 외부 환불 결과 불명: ${this.safeMessage(error)}`);
    // 사유 분류도 정지 판정과 같은 타입 기준을 쓴다. 두 판별이 갈리면 "timeout 사유인데 정지로 기록"
    // 같은 어긋난 조합이 생긴다.
    return error instanceof RefundExecutionTimeoutError
      ? REFUND_EXECUTION_TIMEOUT_REASON
      : 'REFUND_EXECUTION_RESULT_UNKNOWN';
  }

  /**
   * 외부 환불 콜백에 hard timeout 을 건다.
   *
   * 콜백은 취소되지 않으므로 timeout 이 곧 "실행 종료" 는 아니다. 목적은 두 가지다.
   *   ① `SUBMITTING` 이 리스보다 오래 남아 슬롯·워커가 묶이는 것을 막는다.
   *   ② 무한 대기 워커가 heartbeat 로 슬롯을 영구 점유하는 것을 막는다.
   * timeout 이후 살아남은 콜백의 실제 환불은 ledger claim 의 3중 fencing 이 차단하고,
   * 그 콜백의 종료는 `observeLateSettlement` 가 따로 관측해 재조정 근거로 남긴다.
   */
  private async callWithTimeout<T>(pending: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RefundExecutionTimeoutError()), REFUND_EXECUTION_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([pending, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  private safeMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private staleExecution(attemptId: string): ConflictException {
    return new ConflictException({ code: 'REFUND_EXECUTION_STALE', refundAttemptId: attemptId });
  }
}
