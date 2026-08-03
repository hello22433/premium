import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, UpdateQueryBuilder } from 'typeorm';
import { randomUUID } from 'crypto';
import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import {
  DeliveryExclusiveOp,
  DeliverySlotFailureCode,
  DeliveryWorkflowStatus,
} from '../interface/delivery.workflow.status';
import {
  MESSAGE_INFLIGHT_STATUSES,
  MESSAGE_RETRY_BLOCKING_STATUSES,
  MESSAGE_RETRY_RESUME_BLOCKING_STATUSES,
  MESSAGE_SEND_BLOCKING_STATUSES,
  MessageAttemptChannel,
  MessageAttemptStatus,
  MessageAttemptType,
} from '../interface/message.attempt.status';
import { PIN_RETRY_BLOCKING_STATUSES, PinIssueCommandStatus } from '../interface/pin.issue.command.status';

/** 배타 슬롯 리스 기본 길이. 외부 호출 타임아웃은 이 값의 절반 이하로 잡는다(§6.1 fencing 한계). */
export const SLOT_LEASE_MS = 5 * 60 * 1000;

/**
 * operation 별 슬롯 점유 허용 workflow 상태 (§6.1 표 2-1).
 *
 * 이 표는 API 검증용이 아니라 **조건부 UPDATE 의 WHERE 에 그대로 들어간다.**
 * 종결 상태에서 발송·재시도·최초 PIN 발급 계열이 슬롯을 잡지 못하는 것도 여기서 강제된다.
 */
export const ALLOWED_WORKFLOW_STATUSES: Record<DeliveryExclusiveOp, DeliveryWorkflowStatus[]> = {
  [DeliveryExclusiveOp.MESSAGE_SEND]: [DeliveryWorkflowStatus.IN_PROGRESS, DeliveryWorkflowStatus.PENDING_RECONCILE],
  [DeliveryExclusiveOp.PIN_ISSUE]: [DeliveryWorkflowStatus.IN_PROGRESS, DeliveryWorkflowStatus.PENDING_RECONCILE],
  [DeliveryExclusiveOp.RETRY]: [DeliveryWorkflowStatus.IN_PROGRESS, DeliveryWorkflowStatus.PENDING_RECONCILE],
  [DeliveryExclusiveOp.CANCEL_RESEND]: [DeliveryWorkflowStatus.IN_PROGRESS, DeliveryWorkflowStatus.PENDING_RECONCILE],
  [DeliveryExclusiveOp.CANCEL_INFLIGHT_SEND]: [
    DeliveryWorkflowStatus.IN_PROGRESS,
    DeliveryWorkflowStatus.PENDING_RECONCILE,
  ],
  [DeliveryExclusiveOp.RECONCILE]: [
    DeliveryWorkflowStatus.IN_PROGRESS,
    DeliveryWorkflowStatus.PENDING_RECONCILE,
    DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
    DeliveryWorkflowStatus.FAILED_FINAL,
    DeliveryWorkflowStatus.CANCELLED,
    DeliveryWorkflowStatus.RESOLVED_MANUALLY_FAILED,
  ],
  [DeliveryExclusiveOp.MANUAL_RESEND]: [
    DeliveryWorkflowStatus.FAILED_FINAL,
    DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
  ],
  // PIN_REISSUE 는 종결 상태에서 직접 점유하지 않는다. FAILED_FINAL 건은 RECONCILE(REISSUE_REVIEW)로
  // OPS_REVIEW_REQUIRED 로 승격한 뒤에만 재발급한다(상태 우회 차단, §6.1·§6.3).
  [DeliveryExclusiveOp.PIN_REISSUE]: [DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED],
  [DeliveryExclusiveOp.OPS_RESOLVE]: [DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED],
  // RESOLVED_MANUALLY_REFUNDED 는 외부 환불이 확정된 상태라 신규 REFUND 를 금지한다(중복 환불 차단).
  [DeliveryExclusiveOp.REFUND]: [
    DeliveryWorkflowStatus.FAILED_FINAL,
    DeliveryWorkflowStatus.CANCELLED,
    DeliveryWorkflowStatus.RESOLVED_MANUALLY_FAILED,
    DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
  ],
  [DeliveryExclusiveOp.DISCARD]: [
    DeliveryWorkflowStatus.COMPLETED,
    DeliveryWorkflowStatus.FAILED_FINAL,
    DeliveryWorkflowStatus.CANCELLED,
    DeliveryWorkflowStatus.RESOLVED_MANUALLY_SUCCESS,
    DeliveryWorkflowStatus.RESOLVED_MANUALLY_FAILED,
    DeliveryWorkflowStatus.RESOLVED_MANUALLY_REFUNDED,
  ],
};

/**
 * **DUAL_APPROVAL 이 필요한 (op, workflow 상태) 조합** (§6.1 표 2-1·§8.1).
 *
 * DUAL 요구는 op 단위가 아니라 **op × 진입 상태** 단위다. 이 구분을 op 목록으로 뭉개면
 * `OPS_REVIEW_REQUIRED` 의 수동 재발송·환불이 승인 없이 슬롯을 잡아 four-eyes 가 우회된다.
 * - `MANUAL_RESEND` : `FAILED_FINAL` 은 슬롯 fencing 만, `OPS_REVIEW_REQUIRED` 는 DUAL 필수
 * - `REFUND`        : 종결 상태(경로 B)는 DUAL 불요, `OPS_REVIEW_REQUIRED`(경로 A)는 DUAL 필수
 * - `OPS_RESOLVE` / `PIN_REISSUE` : 허용 상태 자체가 `OPS_REVIEW_REQUIRED` 뿐이라 항상 DUAL
 *
 * 승인이 없으면 이 상태들을 **허용 상태 집합에서 뺀 채** 조건부 UPDATE 를 수행하므로,
 * "승인 없이 OPS_REVIEW_REQUIRED 를 점유"하는 경로는 SQL 레벨에서 성립하지 않는다.
 */
export const DUAL_REQUIRED_STATUSES: Partial<Record<DeliveryExclusiveOp, DeliveryWorkflowStatus[]>> = {
  [DeliveryExclusiveOp.MANUAL_RESEND]: [DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED],
  [DeliveryExclusiveOp.REFUND]: [DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED],
  [DeliveryExclusiveOp.OPS_RESOLVE]: [DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED],
  [DeliveryExclusiveOp.PIN_REISSUE]: [DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED],
};

/** 승인 없이 점유 가능한 상태(= 허용 상태 − DUAL 필수 상태). 비어 있으면 승인 없이는 점유 불가한 op 다. */
export function statusesWithoutApproval(op: DeliveryExclusiveOp): DeliveryWorkflowStatus[] {
  const dualOnly = DUAL_REQUIRED_STATUSES[op] ?? [];
  return ALLOWED_WORKFLOW_STATUSES[op].filter((status) => !dualOnly.includes(status));
}

/** 승인을 제시했을 때 점유 가능한 상태(= 허용 상태 ∩ DUAL 필수 상태). 비어 있으면 승인 대상이 아닌 op 다. */
export function statusesWithApproval(op: DeliveryExclusiveOp): DeliveryWorkflowStatus[] {
  const dualOnly = DUAL_REQUIRED_STATUSES[op] ?? [];
  return ALLOWED_WORKFLOW_STATUSES[op].filter((status) => dualOnly.includes(status));
}

export interface SlotApprovalBinding {
  /** 실행에 사용할 승인 행을 **단일 지목**한다. "조건에 맞는 승인이 있으면 통과"는 금지(§6.1). */
  approvalId: string;
  payloadHash: string;
  boundWorkflowVersion: string;
}

export interface AcquireSlotInput {
  orderDeliveryId: number;
  op: DeliveryExclusiveOp;
  /** DUAL op 는 필수. 승인 검증과 슬롯 점유를 2단계로 나누지 않는다(§6.2 버전 경쟁 차단). */
  approval?: SlotApprovalBinding;
  /**
   * `RETRY` 전용 — 메시지 변형의 **재개(resume)** 가드를 쓴다(§5.3 OUTBOX_READY 재개).
   * 크래시로 `OUTBOX_READY` 에 정체된 `AUTO_504` 자식을 동일 attemptId 로 재개할 때는
   * 정체 행 자체가 `OUTBOX_READY` 라 due 가드의 제외 집합을 그대로 쓸 수 없다.
   */
  retryResume?: boolean;
  leaseMs?: number;
  now?: Date;
}

/** 점유에 성공한 슬롯. 이후 모든 상태 반영은 이 3개 값으로 fencing 한다. */
export interface DeliverySlot {
  orderDeliveryId: number;
  op: DeliveryExclusiveOp;
  ownerToken: string;
  workflowVersion: string;
  leaseExpiresAt: Date;
}

export type AcquireSlotResult =
  | { acquired: true; slot: DeliverySlot }
  | {
      acquired: false;
      code: DeliverySlotFailureCode;
      activeOp?: DeliveryExclusiveOp | null;
      leaseExpiresAt?: Date | null;
      workflowStatus?: DeliveryWorkflowStatus | null;
      /** 상태는 op 허용 범위이지만 DUAL 승인이 없어 막힌 경우. 화면은 "승인 요청"을 안내한다(§8.1). */
      requiresDualApproval?: boolean;
    };

/**
 * Level A — workflow 배타 슬롯 서비스. §6.1·§6.2.
 *
 * 교차 operation(발송 vs 환불 등) 충돌을 **단일 조건부 UPDATE** 로 원자적으로 막는다.
 * operation 별 행을 각각 잠그는 방식은 "상태 확인 직후 다른 작업이 선점"하는 TOCTOU 를 못 막으므로 쓰지 않는다.
 *
 * 점유 조건은 세 가지를 모두 WHERE 에 넣는다.
 *   ① 슬롯 공석 또는 리스 만료  ② op 별 허용 workflow 상태(표 2-1)  ③ op 별 가드(재조정·중복·환불 가드)
 * 실패(affected=0)는 원인이 갈리므로 후속 SELECT 로 구분해 서로 다른 코드를 돌려준다.
 */
@Injectable()
export class DeliveryWorkflowSlotService {
  private readonly logger = new Logger(DeliveryWorkflowSlotService.name);

  constructor(
    @InjectRepository(DeliveryWorkflowEntity)
    private readonly workflowRepository: Repository<DeliveryWorkflowEntity>,
  ) {}

  private repo(manager?: EntityManager): Repository<DeliveryWorkflowEntity> {
    return manager ? manager.getRepository(DeliveryWorkflowEntity) : this.workflowRepository;
  }

  /**
   * workflow 앵커 행을 보장한다. 이미 있으면 그대로 두고(경쟁 시 unique 로 1행 유지) 현재 행을 반환한다.
   * 아직 컷오버 전환 마크(`cutoverMigratedAt`)는 세우지 않는다 — 전환은 별도 백필 절차다(§9).
   */
  async ensureWorkflow(orderDeliveryId: number, manager?: EntityManager): Promise<DeliveryWorkflowEntity> {
    const repo = this.repo(manager);
    const existing = await repo.findOne({ where: { orderDeliveryId } });
    if (existing) {
      return existing;
    }

    await repo
      .createQueryBuilder()
      .insert()
      .into(DeliveryWorkflowEntity)
      .values({ orderDeliveryId, workflowStatus: DeliveryWorkflowStatus.IN_PROGRESS })
      .orIgnore()
      .execute();

    const created = await repo.findOne({ where: { orderDeliveryId } });
    if (!created) {
      throw new Error(`delivery_workflow 생성 실패: orderDeliveryId=${orderDeliveryId}`);
    }
    return created;
  }

  /**
   * 배타 슬롯을 점유한다. 성공하면 `workflow_version` 이 +1 된 새 세대의 소유자가 된다.
   */
  async acquire(input: AcquireSlotInput, manager?: EntityManager): Promise<AcquireSlotResult> {
    const { orderDeliveryId, op } = input;
    const now = input.now ?? new Date();
    const leaseMs = input.leaseMs ?? SLOT_LEASE_MS;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const ownerToken = randomUUID();

    // DUAL 요구는 op × 상태 조합이다(§6.1 표 2-1). 승인 유무에 따라 **허용 상태 집합 자체**를 좁혀서
    // "승인 없이 OPS_REVIEW_REQUIRED 점유"(four-eyes 우회)를 SQL 레벨에서 불가능하게 만든다.
    const allowedStatuses = input.approval ? statusesWithApproval(op) : statusesWithoutApproval(op);
    if (allowedStatuses.length === 0) {
      // 승인 없이 점유할 수 있는 상태가 없거나(OPS_RESOLVE/PIN_REISSUE),
      // 승인 대상이 아닌 op 에 승인을 붙인 경우(전용轉用 시도).
      return { acquired: false, code: DeliverySlotFailureCode.DELIVERY_OPERATION_NOT_ALLOWED };
    }

    const repo = this.repo(manager);
    const qb = repo
      .createQueryBuilder()
      .update(DeliveryWorkflowEntity)
      .set({
        activeExclusiveOp: op,
        exclusiveOwnerToken: ownerToken,
        exclusiveLeaseExpiresAt: leaseExpiresAt,
        workflowVersion: () => 'workflow_version + 1',
      })
      .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId })
      .andWhere('workflow_status IN (:...allowedStatuses)', { allowedStatuses })
      .andWhere('(active_exclusive_op IS NULL OR exclusive_lease_expires_at < :now)', { now });

    this.applyOpGuards(qb, op, input);

    if (input.approval) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM dual_approval a
                  WHERE a.id = :approvalId
                    AND a.order_delivery_id = :orderDeliveryId
                    AND a.op = :approvalOp
                    AND a.payload_hash = :payloadHash
                    AND a.bound_workflow_version = :boundWorkflowVersion
                    AND a.status = 'APPROVED'
                    AND a.expires_at > :now)`,
        {
          approvalId: input.approval.approvalId,
          approvalOp: op,
          payloadHash: input.approval.payloadHash,
          boundWorkflowVersion: input.approval.boundWorkflowVersion,
        },
      );
      // 승인이 바인딩한 버전과 실제 버전이 어긋나면 점유 자체가 실패해야 한다(재승인 요구).
      qb.andWhere('workflow_version = :boundWorkflowVersion');
    }

    const result = await qb.execute();

    if (!result.affected) {
      return await this.classifyFailure(orderDeliveryId, op, now, !!input.approval, manager);
    }

    const row = await this.repo(manager).findOne({ where: { orderDeliveryId } });
    if (!row || row.exclusiveOwnerToken !== ownerToken) {
      // 점유 직후 회수된 극단 경쟁. 소유권이 없으므로 실패로 취급한다(ABA 방지).
      return { acquired: false, code: DeliverySlotFailureCode.DELIVERY_OPERATION_LOCKED };
    }

    return {
      acquired: true,
      slot: {
        orderDeliveryId,
        op,
        ownerToken,
        workflowVersion: String(row.workflowVersion),
        leaseExpiresAt,
      },
    };
  }

  /**
   * 리스를 연장한다. 소유 토큰과 workflow_version 이 모두 일치할 때만 적용한다.
   * 불일치면 이미 회수된 것이므로 연장하지 않고 false 를 돌려준다(→ stale 경로).
   */
  async heartbeat(
    slot: DeliverySlot,
    leaseMs = SLOT_LEASE_MS,
    now = new Date(),
    manager?: EntityManager,
  ): Promise<boolean> {
    const result = await this.repo(manager)
      .createQueryBuilder()
      .update(DeliveryWorkflowEntity)
      .set({ exclusiveLeaseExpiresAt: new Date(now.getTime() + leaseMs) })
      .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId: slot.orderDeliveryId })
      .andWhere('active_exclusive_op = :op', { op: slot.op })
      .andWhere('exclusive_owner_token = :ownerToken', { ownerToken: slot.ownerToken })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: slot.workflowVersion })
      .execute();

    return !!result.affected;
  }

  /**
   * 정상 해제(ABA 방지). fencing 조건을 반드시 포함하고 상태 전이와 같은 트랜잭션에서 호출한다.
   * `affected = 0` 이면 이미 회수돼 새 소유자가 점유한 것이므로 **타인의 슬롯을 해제하지 않는다.**
   */
  async release(slot: DeliverySlot, manager?: EntityManager): Promise<boolean> {
    const result = await this.repo(manager)
      .createQueryBuilder()
      .update(DeliveryWorkflowEntity)
      .set({ activeExclusiveOp: null, exclusiveOwnerToken: null, exclusiveLeaseExpiresAt: null })
      .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId: slot.orderDeliveryId })
      .andWhere('active_exclusive_op = :op', { op: slot.op })
      .andWhere('exclusive_owner_token = :ownerToken', { ownerToken: slot.ownerToken })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: slot.workflowVersion })
      .execute();

    if (!result.affected) {
      this.logger.warn(`슬롯 해제 실패(이미 회수됨, ABA 방지). orderDeliveryId=${slot.orderDeliveryId} op=${slot.op}`);
    }

    return !!result.affected;
  }

  /**
   * 쿠폰 전달 완료 표식 (§3 나 — 알림톡·SMS·MMS 중 **하나라도 최종 성공하면 전달 완료**).
   *
   * 결과 조회 배치(Gemtek `MSEQ` 확정)와 알림톡 확정 경로가 **같은 전이를 써야** 채널별로
   * 전달완료 판정이 갈리지 않는다. 종결·수동 종결 상태는 건드리지 않는다(`RESOLVED_MANUALLY_*`
   * 는 불변 override, §7.1).
   */
  async markDelivered(
    orderDeliveryId: number,
    channel: MessageAttemptChannel,
    deliveredAt: Date,
    manager?: EntityManager,
  ): Promise<boolean> {
    const result = await this.repo(manager)
      .createQueryBuilder()
      .update(DeliveryWorkflowEntity)
      .set({
        deliveredFlag: true,
        deliveredChannel: channel,
        deliveredAt,
        workflowStatus: DeliveryWorkflowStatus.COMPLETED,
        stateEnteredAt: deliveredAt,
        workflowVersion: () => 'workflow_version + 1',
      })
      .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId })
      .andWhere('workflow_status IN (:...open)', {
        open: [DeliveryWorkflowStatus.IN_PROGRESS, DeliveryWorkflowStatus.PENDING_RECONCILE],
      })
      .execute();

    return !!result.affected;
  }

  /**
   * op 별 가드를 WHERE 에 결합한다(§6.1 "재조정·중복 트리거 가드").
   * 하나의 공용 가드를 공유하지 않는다 — op 가 다르면 막아야 하는 것도 다르다.
   */
  private applyOpGuards(
    qb: UpdateQueryBuilder<DeliveryWorkflowEntity>,
    op: DeliveryExclusiveOp,
    input?: Pick<AcquireSlotInput, 'retryResume'>,
  ): void {
    switch (op) {
      case DeliveryExclusiveOp.MESSAGE_SEND:
        // 미확정 시도(UNKNOWN·RETRY_SCHEDULED 포함)가 하나라도 있으면 신규 발송을 만들지 않는다.
        qb.andWhere(
          `NOT EXISTS (SELECT 1 FROM message_attempt ma
                        WHERE ma.order_delivery_id = :orderDeliveryId
                          AND ma.status IN (:...messageSendBlocking))`,
          { messageSendBlocking: MESSAGE_SEND_BLOCKING_STATUSES },
        );
        break;

      case DeliveryExclusiveOp.PIN_ISSUE:
        // 최초 발급은 명령이 하나도 없을 때만. 재시도는 RETRY, 재발급은 PIN_REISSUE 소관이다.
        qb.andWhere(`NOT EXISTS (SELECT 1 FROM pin_issue_command pc WHERE pc.order_delivery_id = :orderDeliveryId)`);
        break;

      case DeliveryExclusiveOp.RETRY:
        if (input?.retryResume) {
          // 재개 변형(§5.3): 크래시로 OUTBOX_READY 에 정체된 AUTO_504 자식이 있어야 하고,
          // 그 외 미확정(SUBMITTING 이후·재조정·UNKNOWN)이 없어야 한다. 정체 행 자체가
          // OUTBOX_READY 이므로 due 가드처럼 OUTBOX_READY 를 제외 집합에 두면 항상 실패한다.
          qb.andWhere(
            `EXISTS (SELECT 1 FROM message_attempt ma
                      WHERE ma.order_delivery_id = :orderDeliveryId
                        AND ma.status = :outboxReady AND ma.attempt_type = :auto504)
             AND NOT EXISTS (SELECT 1 FROM message_attempt ma
                      WHERE ma.order_delivery_id = :orderDeliveryId
                        AND ma.status IN (:...messageResumeBlocking))`,
            {
              outboxReady: MessageAttemptStatus.OUTBOX_READY,
              auto504: MessageAttemptType.AUTO_504,
              messageResumeBlocking: MESSAGE_RETRY_RESUME_BLOCKING_STATUSES,
            },
          );
          break;
        }
        // PIN 변형 또는 메시지 변형 중 하나의 대상이 있어야 하고, 각 변형의 미확정 가드를 만족해야 한다.
        qb.andWhere(
          `(
             (EXISTS (SELECT 1 FROM pin_issue_command pc
                       WHERE pc.order_delivery_id = :orderDeliveryId AND pc.status = :pinRetryPending)
              AND NOT EXISTS (SELECT 1 FROM pin_issue_command pc
                       WHERE pc.order_delivery_id = :orderDeliveryId AND pc.status IN (:...pinRetryBlocking)))
             OR
             (EXISTS (SELECT 1 FROM message_attempt ma
                       WHERE ma.order_delivery_id = :orderDeliveryId
                         AND ma.status = :retryScheduled AND ma.next_attempt_at <= :now)
              AND NOT EXISTS (SELECT 1 FROM message_attempt ma
                       WHERE ma.order_delivery_id = :orderDeliveryId
                         AND ma.status IN (:...messageRetryBlocking)))
           )`,
          {
            pinRetryPending: PinIssueCommandStatus.RETRY_PENDING,
            pinRetryBlocking: PIN_RETRY_BLOCKING_STATUSES,
            retryScheduled: MessageAttemptStatus.RETRY_SCHEDULED,
            messageRetryBlocking: MESSAGE_RETRY_BLOCKING_STATUSES,
          },
        );
        break;

      case DeliveryExclusiveOp.CANCEL_RESEND:
        qb.andWhere(
          `EXISTS (SELECT 1 FROM message_attempt ma
                    WHERE ma.order_delivery_id = :orderDeliveryId AND ma.status = :retryScheduled)`,
          { retryScheduled: MessageAttemptStatus.RETRY_SCHEDULED },
        );
        break;

      case DeliveryExclusiveOp.CANCEL_INFLIGHT_SEND:
        qb.andWhere(
          `EXISTS (SELECT 1 FROM message_attempt ma
                    WHERE ma.order_delivery_id = :orderDeliveryId AND ma.status IN (:...inflightStatuses))`,
          { inflightStatuses: MESSAGE_INFLIGHT_STATUSES },
        );
        break;

      case DeliveryExclusiveOp.MANUAL_RESEND:
        // 환불 가드(재무 누수 차단): 환불이 성공/진행 중이면 FAILED_FINAL 이라도 재발송을 열지 않는다.
        qb.andWhere('refunded_at IS NULL AND refund_status IS NULL');
        break;

      case DeliveryExclusiveOp.PIN_REISSUE:
        qb.andWhere('refunded_at IS NULL AND refund_status IS NULL');
        break;

      case DeliveryExclusiveOp.REFUND:
        // 미확정 refund_attempt 가 있으면 신규 환불을 열지 않는다(단일 in-flight, §5.4).
        qb.andWhere(
          `NOT EXISTS (SELECT 1 FROM refund_attempt ra
                        WHERE ra.order_delivery_id = :orderDeliveryId
                          AND ra.status IN ('CLAIMED','SUBMITTING','RECONCILING','UNKNOWN'))`,
        );
        qb.andWhere("refunded_at IS NULL AND (refund_status IS NULL OR refund_status = 'FAILED')");
        break;

      default:
        break;
    }
  }

  /**
   * `affected = 0` 의 원인을 후속 SELECT 로 구분한다(§6.1 슬롯 점유 실패 응답).
   * 하나의 코드로 뭉치면 화면·클라이언트가 "재시도 무의미한 상태 충돌"을 잠금 대기로 오해한다.
   */
  private async classifyFailure(
    orderDeliveryId: number,
    op: DeliveryExclusiveOp,
    now: Date,
    hadApproval: boolean,
    manager?: EntityManager,
  ): Promise<AcquireSlotResult> {
    const row = await this.repo(manager).findOne({ where: { orderDeliveryId } });

    if (!row) {
      return { acquired: false, code: DeliverySlotFailureCode.DELIVERY_WORKFLOW_NOT_FOUND };
    }

    const leaseValid = !!row.exclusiveLeaseExpiresAt && row.exclusiveLeaseExpiresAt.getTime() > now.getTime();
    if (row.activeExclusiveOp && leaseValid) {
      return {
        acquired: false,
        code: DeliverySlotFailureCode.DELIVERY_OPERATION_LOCKED,
        activeOp: row.activeExclusiveOp,
        leaseExpiresAt: row.exclusiveLeaseExpiresAt,
        workflowStatus: row.workflowStatus,
      };
    }

    const effectiveStatuses = hadApproval ? statusesWithApproval(op) : statusesWithoutApproval(op);
    if (!effectiveStatuses.includes(row.workflowStatus)) {
      return {
        acquired: false,
        code: DeliverySlotFailureCode.DELIVERY_OPERATION_NOT_ALLOWED,
        workflowStatus: row.workflowStatus,
        // 상태 자체는 op 허용 범위인데 승인이 없어 막힌 경우 = DUAL 필요(재승인/승인 요청 안내용).
        requiresDualApproval: !hadApproval && statusesWithApproval(op).includes(row.workflowStatus),
      };
    }

    if (op === DeliveryExclusiveOp.MANUAL_RESEND && (row.refundedAt || row.refundStatus)) {
      return {
        acquired: false,
        code: DeliverySlotFailureCode.DELIVERY_REFUND_BLOCKS_RESEND,
        workflowStatus: row.workflowStatus,
      };
    }

    switch (op) {
      case DeliveryExclusiveOp.CANCEL_RESEND:
        return {
          acquired: false,
          code: DeliverySlotFailureCode.DELIVERY_RESEND_NOT_SCHEDULED,
          workflowStatus: row.workflowStatus,
        };
      case DeliveryExclusiveOp.CANCEL_INFLIGHT_SEND:
        return {
          acquired: false,
          code: DeliverySlotFailureCode.DELIVERY_NO_INFLIGHT_SEND,
          workflowStatus: row.workflowStatus,
        };
      case DeliveryExclusiveOp.MESSAGE_SEND:
      case DeliveryExclusiveOp.PIN_ISSUE:
      case DeliveryExclusiveOp.RETRY:
        return {
          acquired: false,
          code: DeliverySlotFailureCode.DELIVERY_RECONCILE_IN_PROGRESS,
          workflowStatus: row.workflowStatus,
        };
      default:
        // DUAL op 의 승인 불일치·만료·버전 변동을 포함한다 → 재승인 요구.
        return {
          acquired: false,
          code: DeliverySlotFailureCode.DELIVERY_OPERATION_NOT_ALLOWED,
          workflowStatus: row.workflowStatus,
        };
    }
  }
}
