import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Not, IsNull, Repository } from 'typeorm';
import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import { RefundAttemptEntity } from '../../entity/refund.attempt.entity';
import {
  CutoverPhase,
  DELIVERY_CUTOVER_DRAINING,
  DELIVERY_CUTOVER_LEGACY_BLOCKED,
  LegacyDeliveryEntryPoint,
} from '../interface/legacy.delivery.entry.point';
import { DeliveryExclusiveOp, DeliveryWorkflowStatus } from '../interface/delivery.workflow.status';
import { REFUND_EXECUTING_STATUSES } from '../interface/refund.attempt.status';

export interface LegacySplitResult {
  /** 미전환 건 — 기존 `claimedAt` 토큰 모델로 계속 처리한다. */
  allowed: number[];
  /** 전환 건 — legacy 경로에서 제외한다. 신규 workflow 경로가 처리한다. */
  blocked: number[];
}

/**
 * 전환 건에서 "직전 발송이 실패로 남아 있다"고 보는 workflow 업무 상태 (§5.1·§8.1 A).
 *
 * legacy `status IN (FAIL, FAIL_SMS)` 의 workflow 대응물이다. `OPS_REVIEW_REQUIRED` 는 미종결이지만
 * 실패내역에 노출돼 수동 재발송 대상이므로 포함한다. `PENDING_RECONCILE`(결과 미확정)은 제외한다 —
 * 아직 실패로 확정되지 않았고, 그 상태에서 재발송을 최초 발송처럼 다루면 이중 발송이 된다.
 */
const WORKFLOW_RESEND_SOURCE_STATUSES: DeliveryWorkflowStatus[] = [
  DeliveryWorkflowStatus.FAILED_FINAL,
  DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
  DeliveryWorkflowStatus.RESOLVED_MANUALLY_FAILED,
];

/**
 * `refund_attempt` 실행 단계임을 증명하는 3중 fencing (§6.1 `ownerToken`+`generation`+`workflowVersion`).
 *
 * 네 값은 모두 **BIGINT 를 문자열로 모델링**한 컬럼과 대조되므로 `string` 이다. `number` 로 다루면
 * `Number.MAX_SAFE_INTEGER`(2^53-1)를 넘는 id·세대에서 정밀도가 깨져 **다른 행과 대조**될 수 있다.
 */
export interface RefundExecutionFencing {
  /** `refund_attempt.id` (BIGINT → string) */
  refundAttemptId: string;
  /** 실행 워커가 쥔 Level A 슬롯 소유자 토큰. workflow·attempt 양쪽과 일치해야 한다. */
  ownerToken: string;
  /** `refund_attempt.generation` (BIGINT → string) */
  generation: string;
  /** 점유 시 바인딩된 `workflow_version` (BIGINT → string) */
  workflowVersion: string;
}

export interface RefundExecutionGateInput {
  orderDeliveryId: number;
  entryPoint: LegacyDeliveryEntryPoint;
  /** 미전환 건은 없어도 된다. 전환 건은 없으면 거부된다. */
  fencing?: RefundExecutionFencing | null;
  /** 리스 만료 판정 기준 시각(테스트 주입용). 기본 현재 시각. */
  now?: Date;
}

/**
 * 컷오버 전환 마크 기반 legacy 진입 거부 게이트. §9 「기존 경로 컷오버·마이그레이션 계약」.
 *
 * 기존 `claimedAt`/`mutationClaimedAt` 토큰 모델과 신규 Level A 슬롯 모델은 서로를 모른다.
 * 두 모델이 같은 `order_delivery` 를 동시에 잡으면 이중 발송·중복 발급·중복 환불이 뚫리므로,
 * **한 건은 어느 한 시점에 정확히 하나의 경로로만** 처리한다(§9 단일 동시성 모델 원칙).
 *
 * 판정 근거는 설정 플래그가 아니라 **데이터 사실**(`delivery_workflow.cutover_migrated_at`)이다.
 * 그래서 플래그를 되돌려도 legacy 가 전환 건을 다시 처리하지 못한다(§9 롤백 규칙).
 *
 * **fail-closed** — 전환 여부를 확인하지 못하면 통과시키지 않고 오류를 그대로 전파한다.
 * 이 조회는 legacy 작업과 같은 DB 를 쓰므로, 조회가 실패하는 상황이면 legacy 작업도 어차피 실패한다.
 * 반대로 fail-open 하면 "DB 가 흔들리는 순간에만 이중 동시성 모델이 열리는" 최악의 경로가 생긴다.
 *
 * 이 서비스는 다른 도메인 서비스에 의존하지 않는다(`DeliveryCutoverModule` 이 독립 모듈인 이유).
 * customer_service·external_api·ssg_event 등 어디서든 순환 import 없이 주입할 수 있어야 하기 때문이다.
 */
@Injectable()
export class DeliveryCutoverGuardService {
  private readonly logger = new Logger(DeliveryCutoverGuardService.name);

  constructor(
    @InjectRepository(DeliveryWorkflowEntity)
    private readonly workflowRepository: Repository<DeliveryWorkflowEntity>,
    @InjectRepository(RefundAttemptEntity)
    private readonly refundAttemptRepository: Repository<RefundAttemptEntity>,
  ) {}

  private repo(manager?: EntityManager): Repository<DeliveryWorkflowEntity> {
    return manager ? manager.getRepository(DeliveryWorkflowEntity) : this.workflowRepository;
  }

  private refundAttemptRepo(manager?: EntityManager): Repository<RefundAttemptEntity> {
    return manager ? manager.getRepository(RefundAttemptEntity) : this.refundAttemptRepository;
  }

  /**
   * legacy 진입을 거부한다. legacy 진입점 **최상단**(트랜잭션·외부 호출 시작 전)에서 호출한다.
   *
   * `DRAINING`·`MIGRATED` 둘 다 거부 대상이다. 드레이닝은 "전환 예정이라 legacy 신규 진입만 먼저
   * 막아둔" 상태이므로, 여기서 통과시키면 quiesce 자체가 성립하지 않는다(§9 admission race).
   *
   * 여러 건을 한 번에 처리하는 진입점은 `splitLegacyAllowed` 로 해당 건만 건너뛰는 편이 낫다.
   * 이 메서드는 한 건이라도 걸리면 전체를 거부한다.
   */
  async assertLegacyAllowed(
    orderDeliveryId: number | number[],
    entryPoint: LegacyDeliveryEntryPoint,
    manager?: EntityManager,
  ): Promise<void> {
    const ids = Array.isArray(orderDeliveryId) ? orderDeliveryId : [orderDeliveryId];
    const phases = await this.phasesOf(ids, manager);
    const blocked = [...phases.entries()].filter(([, phase]) => phase !== CutoverPhase.NONE);
    if (blocked.length === 0) {
      return;
    }

    const blockedIds = blocked.map(([id]) => id);
    const draining = blocked.some(([, phase]) => phase === CutoverPhase.DRAINING);
    this.logger.warn(
      `[CUTOVER] legacy 진입 거부(${draining ? 'DRAINING' : 'MIGRATED'}). ` +
        `entryPoint=${entryPoint}, orderDeliveryIds=${blockedIds.join(',')}`,
    );
    throw new ConflictException({
      code: DELIVERY_CUTOVER_LEGACY_BLOCKED,
      entryPoint,
      orderDeliveryIds: blockedIds,
      phase: draining ? CutoverPhase.DRAINING : CutoverPhase.MIGRATED,
      message: draining
        ? `컷오버 드레이닝 중이라 기존 경로로 처리할 수 없습니다. 전환 완료 후 신규 경로로 재시도하세요. ` +
          `(entryPoint: ${entryPoint}, orderDeliveryIds: ${blockedIds.join(',')})`
        : `컷오버 전환 건은 기존 경로로 처리할 수 없습니다. 신규 workflow 경로를 사용하세요. ` +
          `(entryPoint: ${entryPoint}, orderDeliveryIds: ${blockedIds.join(',')})`,
    });
  }

  /** 배치·일괄 진입점용 — 거부 대상만 걸러내고 나머지는 legacy 로 계속 처리한다. */
  async splitLegacyAllowed(orderDeliveryIds: number[], manager?: EntityManager): Promise<LegacySplitResult> {
    const phases = await this.phasesOf(orderDeliveryIds, manager);
    const blocked = [...phases.entries()].filter(([, phase]) => phase !== CutoverPhase.NONE).map(([id]) => id);
    if (blocked.length === 0) {
      return { allowed: [...new Set(orderDeliveryIds)], blocked: [] };
    }

    const blockedSet = new Set(blocked);
    return {
      allowed: [...new Set(orderDeliveryIds)].filter((id) => !blockedSet.has(id)),
      blocked,
    };
  }

  /**
   * 발송 경로의 모델 라우팅 판정 (§9 단일 동시성 모델 원칙).
   *
   * - `NONE`     → `false`. 기존 `claimedAt` 모델로 발송한다.
   * - `MIGRATED` → `true`. Level A 슬롯을 점유해야만 발송한다.
   * - `DRAINING` → **양쪽 모두 금지**이므로 boolean 으로 답할 수 없다. 거부로 던진다.
   *   드레이닝은 legacy 를 비우는 짧은 구간이고, 여기서 신규 모델을 먼저 시작하면 아직 빠져나가지
   *   못한 legacy 워커와 겹친다 — quiesce 를 두는 이유가 사라진다.
   */
  async isCutover(orderDeliveryId: number, manager?: EntityManager): Promise<boolean> {
    const phase = (await this.phasesOf([orderDeliveryId], manager)).get(orderDeliveryId) ?? CutoverPhase.NONE;
    if (phase === CutoverPhase.DRAINING) {
      this.logger.warn(`[CUTOVER] 드레이닝 중 발송 보류. orderDeliveryId=${orderDeliveryId}`);
      throw new ConflictException({
        code: DELIVERY_CUTOVER_DRAINING,
        orderDeliveryIds: [orderDeliveryId],
        phase,
        message:
          `컷오버 드레이닝 중에는 발송을 시작하지 않습니다(legacy 잔여 작업 배출 대기). ` +
          `(orderDeliveryId: ${orderDeliveryId})`,
      });
    }
    return phase === CutoverPhase.MIGRATED;
  }

  /**
   * **발송 진입점의 "실패 재발송인가" 판별 SoT** (§8 화면/판정 SoT 고정, HIGH 4).
   *
   * 발송 진입점(`oneSend` 등)은 지금까지 `order_delivery.status IN (FAIL, FAIL_SMS)` 로 최초/재발송을
   * 갈랐다. **미전환 건에서는 이 값이 파생 미러가 아니라 실제 SoT 라 옳다.** 그러나 컷오버 마크가
   * 서는 순간 `status` 는 legacy 호환 표시용 미러로 격하되므로, 같은 판별을 계속 쓰면 최초/재발송이
   * 뒤집힌다 — 재발송을 최초로 오인하면 환불 복구(`reverseRefundForResend`)와 `RESEND` attempt
   * 선발급이 통째로 누락되고, 최초를 재발송으로 오인하면 있지도 않은 환불을 되감는다.
   *
   * @returns `null` 이면 **미전환 건** — 호출자가 종전대로 legacy `status` 로 판단한다(동작 불변).
   *          `boolean` 이면 전환 건이며, workflow 업무 상태로 판정한 재발송 여부다.
   */
  async isWorkflowResend(orderDeliveryId: number, manager?: EntityManager): Promise<boolean | null> {
    const repository = manager ? manager.getRepository(DeliveryWorkflowEntity) : this.workflowRepository;
    const workflow = await repository.findOne({
      where: { orderDeliveryId },
      select: ['id', 'workflowStatus', 'cutoverMigratedAt'],
    });

    if (!workflow?.cutoverMigratedAt) {
      return null;
    }

    return WORKFLOW_RESEND_SOURCE_STATUSES.includes(workflow.workflowStatus);
  }

  /**
   * 환불 실행 게이트 (§9 인벤토리 #12 — ledger claim 의 `refund_attempt` 종속).
   *
   * 전환 건의 환불은 `refund_attempt` 단일 in-flight 가 **상위 게이트**이고 ledger claim 은 그
   * 하위 멱등 확인이다. "id 를 넘겼다"는 사실은 통과 증명이 아니므로, **3중 fencing 을 포함한
   * 단일 조인 쿼리**로 다음을 한 번에 확인한다(§6.1 `ownerToken` + `generation` + `workflowVersion`).
   *   ① `refund_attempt` 가 그 `order_delivery` 소유이고 **실행 중**(`CLAIMED`/`SUBMITTING`)일 것
   *      — 터미널·`RECONCILING`·`UNKNOWN` 은 외부 환불을 새로 실행하는 상태가 아니다(§5.4)
   *   ② Level A 슬롯이 **`REFUND` 로 점유**돼 있고 **리스가 살아 있을 것**
   *   ③ 호출자가 제시한 `ownerToken`·`generation`·`workflowVersion` 이 **attempt 와 workflow 양쪽에
   *      동시에 일치**할 것 — lease 를 뺏긴 stale worker 의 ledger claim 을 막는 핵심 조건이다.
   *      슬롯이 회수·재점유되면 `workflow_version` 이 +1 되고 `exclusive_owner_token` 이 바뀌므로,
   *      옛 토큰을 쥔 워커는 이 조인을 통과하지 못한다.
   *
   * 판정은 **단일 쿼리 결과**가 권위이며, 실패했을 때만 원인 코드를 얻기 위해 단계별로 다시 조회한다
   * (진단용 조회 사이에 상태가 또 바뀌어도 이미 거부는 확정이라 안전하다).
   *
   * 미전환 건은 애초에 신규 모델 대상이 아니므로 이 검사를 하지 않는다.
   */
  async assertRefundExecutionAllowed(input: RefundExecutionGateInput, manager?: EntityManager): Promise<void> {
    const { orderDeliveryId, fencing } = input;

    const workflow = await this.repo(manager).findOne({
      select: [
        'orderDeliveryId',
        'cutoverDrainingAt',
        'cutoverMigratedAt',
        'activeExclusiveOp',
        'exclusiveLeaseExpiresAt',
      ],
      where: { orderDeliveryId },
    });
    if (!workflow?.cutoverMigratedAt && !workflow?.cutoverDrainingAt) {
      return;
    }

    // 드레이닝 구간에는 legacy 환불도, 신규 환불도 시작하지 않는다(quiesce).
    if (!workflow.cutoverMigratedAt) {
      throw this.refundBlocked(input, 'CUTOVER_DRAINING');
    }

    if (!fencing?.refundAttemptId || !fencing.ownerToken || !fencing.generation || !fencing.workflowVersion) {
      throw this.refundBlocked(input, 'REFUND_EXECUTION_FENCING_REQUIRED');
    }

    const now = input.now ?? new Date();
    const owned = await this.repo(manager)
      .createQueryBuilder('w')
      .innerJoin(RefundAttemptEntity, 'ra', 'ra.order_delivery_id = w.order_delivery_id')
      .where('w.order_delivery_id = :orderDeliveryId', { orderDeliveryId })
      .andWhere('w.cutover_migrated_at IS NOT NULL')
      // ② 슬롯 점유 + 리스 생존
      .andWhere('w.active_exclusive_op = :refundOp', { refundOp: DeliveryExclusiveOp.REFUND })
      .andWhere('w.exclusive_lease_expires_at > :now', { now })
      // ③ workflow 쪽 fencing
      .andWhere('w.exclusive_owner_token = :ownerToken', { ownerToken: fencing.ownerToken })
      .andWhere('w.workflow_version = :workflowVersion', { workflowVersion: fencing.workflowVersion })
      // ① attempt 소유 + 실행 상태
      .andWhere('ra.id = :refundAttemptId', { refundAttemptId: fencing.refundAttemptId })
      .andWhere('ra.status IN (:...executing)', { executing: REFUND_EXECUTING_STATUSES })
      // ③ attempt 쪽 fencing (같은 세대·같은 소유자여야 한다)
      .andWhere('ra.owner_token = :ownerToken')
      .andWhere('ra.generation = :generation', { generation: fencing.generation })
      .andWhere('ra.workflow_version = :workflowVersion')
      .getCount();

    if (owned === 0) {
      throw this.refundBlocked(input, await this.diagnoseRefundGate(input, workflow, now, manager));
    }
  }

  /** 거부 원인 코드를 좁힌다. 권위 판정은 이미 끝났고 여기서는 운영 진단만 만든다. */
  private async diagnoseRefundGate(
    input: RefundExecutionGateInput,
    workflow: DeliveryWorkflowEntity,
    now: Date,
    manager?: EntityManager,
  ): Promise<string> {
    const fencing = input.fencing!;

    const leaseAlive =
      workflow.exclusiveLeaseExpiresAt != null && workflow.exclusiveLeaseExpiresAt.getTime() > now.getTime();
    if (workflow.activeExclusiveOp !== DeliveryExclusiveOp.REFUND || !leaseAlive) {
      return 'REFUND_SLOT_NOT_HELD';
    }

    const attempt = await this.refundAttemptRepo(manager).findOne({
      select: ['id', 'orderDeliveryId', 'status', 'ownerToken', 'generation', 'workflowVersion'],
      where: { id: fencing.refundAttemptId },
    });
    if (!attempt || attempt.orderDeliveryId !== input.orderDeliveryId) {
      return 'REFUND_ATTEMPT_NOT_OWNED';
    }
    if (!REFUND_EXECUTING_STATUSES.includes(attempt.status)) {
      return 'REFUND_ATTEMPT_NOT_EXECUTING';
    }
    // 남은 원인은 fencing 불일치뿐이다 = lease 를 뺏긴 stale worker.
    return 'REFUND_FENCING_MISMATCH';
  }

  /** 환불 실행 게이트 거부 응답. 원인(`reason`)을 남겨 운영이 "무엇이 빠졌는지"를 바로 알 수 있게 한다. */
  private refundBlocked(input: RefundExecutionGateInput, reason: string): ConflictException {
    this.logger.warn(
      `[CUTOVER] 전환 건의 환불 실행 거부(${reason}). entryPoint=${input.entryPoint}, ` +
        `orderDeliveryId=${input.orderDeliveryId}, refundAttemptId=${input.fencing?.refundAttemptId ?? 'null'}`,
    );
    return new ConflictException({
      code: DELIVERY_CUTOVER_LEGACY_BLOCKED,
      entryPoint: input.entryPoint,
      orderDeliveryIds: [input.orderDeliveryId],
      reason,
      message:
        `컷오버 전환 건의 환불은 refund_attempt 실행 단계에서만 가능합니다. ` +
        `(orderDeliveryId: ${input.orderDeliveryId}, reason: ${reason})`,
    });
  }

  /**
   * 각 발송건의 컷오버 단계를 돌려준다. 마크가 없거나 행 자체가 없으면 결과에 없다(= `NONE`).
   * `MIGRATED` 가 `DRAINING` 보다 우선한다 — 전환이 끝난 뒤에도 드레이닝 마크를 남겨두기 때문이다
   * (감사 목적. 언제 quiesce 를 시작했는지 기록으로 남긴다).
   */
  private async phasesOf(orderDeliveryIds: number[], manager?: EntityManager): Promise<Map<number, CutoverPhase>> {
    const ids = [...new Set(orderDeliveryIds)];
    const phases = new Map<number, CutoverPhase>();
    if (ids.length === 0) {
      return phases;
    }

    const rows = await this.repo(manager).find({
      select: ['orderDeliveryId', 'cutoverDrainingAt', 'cutoverMigratedAt'],
      where: [
        { orderDeliveryId: In(ids), cutoverMigratedAt: Not(IsNull()) },
        { orderDeliveryId: In(ids), cutoverDrainingAt: Not(IsNull()) },
      ],
    });
    for (const row of rows) {
      phases.set(row.orderDeliveryId, row.cutoverMigratedAt ? CutoverPhase.MIGRATED : CutoverPhase.DRAINING);
    }
    return phases;
  }
}
