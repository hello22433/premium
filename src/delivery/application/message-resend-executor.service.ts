import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import { MessageAttemptEntity } from '../../entity/message.attempt.entity';
import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import { NOT_CUTOVER_ORDER_DELIVERY } from '../interface/legacy.delivery.entry.point';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { MessageAttemptChannel, MessageAttemptStatus, MessageAttemptType } from '../interface/message.attempt.status';
import { DeliveryExclusiveOp, LEGACY_SEND_OP } from '../interface/delivery.workflow.status';
import { MUTATION_CLAIM_STALE_MS, UNSENDABLE_COUPON_STATUSES } from '../interface/order.delivery.mutation.claim';
import { generateAttemptId } from '../domain/message.attempt.id';
import { isWithinAllowedSendWindow } from '../domain/resend.schedule';
import { DeliverySlot, DeliveryWorkflowSlotService } from './delivery-workflow-slot.service';
import { MessageAttemptService } from './message-attempt.service';
import { MessageResultReconcileService, SLA_OUTBOX_READY_MS } from './message-result-reconcile.service';
import { DeliveryBatchService } from './delivery.batch.service';

/** 한 사이클에서 실행할 재발송 수 상한(504 는 3개월 88건 수준 — 낮은 상한으로 충분하다). */
const DUE_RESEND_BATCH_SIZE = 50;

/** 트랜잭션 내 delivered 가드가 "타 채널 전달 완료"를 확인한 경우의 반환값. */
const DELIVERED = Symbol('DELIVERED');

export interface DueResendSummary {
  scanned: number;
  /** 예약 도래 → 원 시도 RETRIED + 신규 AUTO_504 시도 발송 */
  resent: number;
  /** 크래시로 OUTBOX_READY 에 정체된 자동 재발송 자식을 동일 attemptId 로 재개 */
  resumed: number;
  /** 실행 시점 기한(retry_deadline_at) 초과 → FAILED_FINAL */
  expired: number;
  /** 타 채널 전달 완료 → CANCELLED_SUPERSEDED(실패·환불 후보 아님) */
  superseded: number;
  skipped: number;
}

/** 미전환 건의 legacy 동시성 게이트(claimedAt/mutationClaimedAt) 또는 전환 건의 Level A 슬롯. */
type ResendGate = { kind: 'slot'; slot: DeliverySlot } | { kind: 'legacy'; claimAt: Date };

/**
 * 504 자동 재발송 실행기 — §6.3 표 1 `dueResend` (RETRY 메시지 변형).
 *
 * `MessageResultReconcileService` 가 504 확정 건을 `RETRY_SCHEDULED` 로 예약하면(§4·§7.2),
 * 이 실행기가 `nextAttemptAt` 도래 시 다음을 수행한다.
 *
 * - **원자성(§5.3):** 하나의 DB 트랜잭션에서 ① workflow 행 잠금 + `delivered_flag=false` 확인
 *   ② 원 시도 `RETRY_SCHEDULED → RETRIED` 조건부 갱신 ③ `retryOfAttemptId` 로 연결된
 *   신규 시도(`OUTBOX_READY`) 생성. **Gemtek 외부 호출은 commit 후에만.**
 * - **전달 완료 경쟁(§3 나):** delivered 판정은 두 곳에서 원자적으로 강제된다 — ⓐ 자식 생성
 *   트랜잭션의 workflow 행 잠금(불필요한 자식 생성 차단), ⓑ `trackPreparedSend` 의
 *   `delivered_flag=false ∧ OUTBOX_READY → SUBMITTING` **단일 조건부 UPDATE**(제출 게이트 —
 *   read 후 별도 전이가 남기는 경쟁 창이 없다). 제출 시작(`SUBMITTING` 커밋) 이후의 지연
 *   전달 완료만 §3 나가 명시 수용하는 in-flight 중복으로 남는다.
 * - **체인당 1회:** 최초 시도(`retryOfAttemptId IS NULL`)에서만 트리거하고, DB 의
 *   `(rootAttemptId, 'AUTO_504')` unique 가 최종 강제한다(무한 연쇄 차단, §4).
 * - **기한(§7.2):** 판정 시점은 실제 실행 시점이며 기준은 `retry_deadline_at`(504 확정 + 24h)이다.
 *   넘겼으면 재발송 없이 `FAILED_FINAL` 로 종결한다(기한 예외 승인 절차 없음).
 * - **시간대(§7.2):** 08:00–20:00 KST 밖에서는 실행하지 않는다.
 * - **동시성(§9 단일 모델 원칙):** 전환 건은 `RETRY` 배타 슬롯(op 가드 포함)으로, 미전환 건은
 *   기존 `claimedAt`/`mutationClaimedAt` claim 으로만 직렬화한다. 두 모델을 겹쳐 쓰지 않는다.
 *   전환 건의 `OUTBOX_READY` 정체 재개는 `RETRY` 재개 변형 가드(`retryResume`)로 점유한다.
 * - **§10 4단계 canary:** `DELIVERY_AUTO_RESEND_504_ENABLED=true` 일 때만 동작한다(예약 생성과 동일 플래그).
 */
@Injectable()
export class MessageResendExecutorService {
  private readonly logger = new Logger(MessageResendExecutorService.name);

  constructor(
    @InjectRepository(MessageAttemptEntity)
    private readonly attemptRepository: Repository<MessageAttemptEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private readonly orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    private readonly slotService: DeliveryWorkflowSlotService,
    private readonly messageAttemptService: MessageAttemptService,
    private readonly reconcileService: MessageResultReconcileService,
    private readonly deliveryBatchService: DeliveryBatchService,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** 504 자동 재발송 활성화 여부(§10 4단계 canary). 예약 생성(reconcile)과 같은 플래그를 쓴다. */
  private get auto504Enabled(): boolean {
    return this.configService.get('DELIVERY_AUTO_RESEND_504_ENABLED') === 'true';
  }

  /** 예약 도래 건 실행 + OUTBOX_READY 정체 자식 재개. */
  async runDueResendOnce(now: Date = new Date()): Promise<DueResendSummary> {
    const summary: DueResendSummary = { scanned: 0, resent: 0, resumed: 0, expired: 0, superseded: 0, skipped: 0 };

    if (!this.auto504Enabled) {
      return summary;
    }
    if (!isWithinAllowedSendWindow(now)) {
      // 창 밖 실행(cron 드리프트 등)은 발송을 버리지 않고 다음 허용 창에서 처리한다(§7.2).
      return summary;
    }

    // 예약 도래분. 자동 재발송은 최초 시도에서만 트리거한다(재발송 자식의 재-504 는 즉시 FAILED_FINAL, §4).
    const due = await this.attemptRepository.find({
      where: {
        status: MessageAttemptStatus.RETRY_SCHEDULED,
        nextAttemptAt: LessThanOrEqual(now),
        retryOfAttemptId: IsNull(),
        cancelRequestedAt: IsNull(),
      },
      order: { nextAttemptAt: 'ASC' },
      take: DUE_RESEND_BATCH_SIZE,
    });

    // 크래시로 OUTBOX_READY 에 정체된 자동 재발송 자식. 외부 호출 전임이 확정이므로
    // 재조회 없이 **동일 attemptId 로 최초 insert 를 그대로 재개**한다(blind 재삽입 아님, §5.3).
    const stuck = await this.attemptRepository.find({
      where: {
        status: MessageAttemptStatus.OUTBOX_READY,
        attemptType: MessageAttemptType.AUTO_504,
        cancelRequestedAt: IsNull(),
        stateEnteredAt: LessThan(new Date(now.getTime() - SLA_OUTBOX_READY_MS)),
      },
      order: { stateEnteredAt: 'ASC' },
      take: DUE_RESEND_BATCH_SIZE,
    });

    for (const attempt of [...due, ...stuck]) {
      summary.scanned++;
      try {
        await this.executeOne(attempt, now, summary);
      } catch (e) {
        summary.skipped++;
        this.logger.error(`[DUE_RESEND] 실행 실패(다음 사이클 재시도). attemptId=${attempt.attemptId}: ${e}`);
      }
    }

    return summary;
  }

  private async executeOne(attempt: MessageAttemptEntity, now: Date, summary: DueResendSummary): Promise<void> {
    // ① 기한 판정은 실행 시점(§7.2). 기한 컬럼이 없는 과거 행은 sweep 의 보수 판정에 맡긴다.
    if (attempt.retryDeadlineAt && attempt.retryDeadlineAt.getTime() < now.getTime()) {
      await this.expire(attempt, now);
      summary.expired++;
      return;
    }

    const workflow = await this.slotService.ensureWorkflow(attempt.orderDeliveryId);

    // ② 한 채널이라도 최종 성공했으면 남은 예약을 취소 종결한다 — 실패·환불 후보가 아니다(§3 나).
    //    (빠른 경로 — 원자 판정은 트랜잭션 내 delivered 가드와 제출 직전 재확인이 담당한다.)
    if (workflow.deliveredFlag) {
      if (await this.supersede(attempt, now)) {
        summary.superseded++;
      }
      return;
    }

    // ③ 504 는 Gemtek(SMS/MMS) 결과에서만 온다. 그 외 채널 예약은 데이터 이상 — 건드리지 않고 관측만.
    if (attempt.channel !== MessageAttemptChannel.SMS && attempt.channel !== MessageAttemptChannel.MMS) {
      this.logger.warn(`[DUE_RESEND] 재발송 불가 채널 예약. attemptId=${attempt.attemptId} channel=${attempt.channel}`);
      summary.skipped++;
      return;
    }

    const resume = attempt.status === MessageAttemptStatus.OUTBOX_READY;
    const gate = await this.acquireGate(workflow, attempt.orderDeliveryId, now, resume);
    if (!gate) {
      summary.skipped++;
      return;
    }

    try {
      // ④ 죽은 핀·환불 재확인 — legacy claim CAS 는 이미 걸렀지만 슬롯 경로(RETRY 가드에 환불 조건 없음)의
      //    공통 안전망이다. 걸리면 발송하지 않고 예약은 sweep 의 기한 판정으로 종결되게 둔다.
      const od = await this.orderDeliveryRepository.findOne({
        where: { id: attempt.orderDeliveryId },
        withDeleted: true,
      });
      const couponDead =
        !od ||
        !!od.deletedAt ||
        (od.couponStatus && UNSENDABLE_COUPON_STATUSES.includes(od.couponStatus)) ||
        !!od.refundedAt ||
        !!od.refundStatus;
      if (couponDead) {
        this.logger.warn(
          `[DUE_RESEND] 폐기·환불·삭제 건은 재발송하지 않는다. ` +
            `orderDeliveryId=${attempt.orderDeliveryId} attemptId=${attempt.attemptId}`,
        );
        summary.skipped++;
        return;
      }

      // ⑤ 발송 payload 구성(외부 부작용 없음). 발급 전·삭제 건이면 여기서 throw → skip.
      const dispatch = await this.deliveryBatchService.prepareCouponResendDispatch(
        attempt.orderDeliveryId,
        attempt.channel,
      );

      let target: MessageAttemptEntity;
      if (resume) {
        target = attempt;
      } else {
        // ⑥ 원자적 변경(§5.3): workflow 행 잠금 + delivered 확인 → 원 시도 RETRIED → 자식 생성.
        const child = await this.createRetriedChild(attempt, workflow, gate, now);
        if (child === DELIVERED) {
          // 잠금 하에 전달 완료가 확인됐다 — 자식 없이 원 예약을 취소 종결한다(§3 나).
          if (await this.supersede(attempt, now)) {
            summary.superseded++;
          }
          return;
        }
        if (!child) {
          summary.skipped++;
          return;
        }
        target = child;
      }

      // ⑦ commit 후 외부 호출. delivered_flag=false 검증과 SUBMITTING 전이는
      //    trackPreparedSend 의 **단일 조건부 UPDATE** 가 원자적으로 수행한다(§3 나, PR#32 HIGH).
      //    delivered 로 막히면 attempt 는 그 안에서 CANCELLED_SUPERSEDED 로 종결된다.
      const outcome = await this.messageAttemptService.trackPreparedSend(target, dispatch);
      if (outcome === 'SENT') {
        if (resume) {
          summary.resumed++;
        } else {
          summary.resent++;
          this.logger.log(
            `[DUE_RESEND] 504 자동 재발송 실행. orderDeliveryId=${attempt.orderDeliveryId} ` +
              `root=${attempt.rootAttemptId} child=${target.attemptId}`,
          );
        }
      } else if (outcome === 'SUPERSEDED') {
        summary.superseded++;
      } else {
        summary.skipped++;
      }
    } finally {
      await this.releaseGate(attempt.orderDeliveryId, gate);
    }
  }

  /**
   * §5.3 재발송 두 행 변경의 원자성 — 단일 트랜잭션에서 다음을 수행한다.
   *   ① workflow 행을 잠그고(`pessimistic_write`) `delivered_flag=false` 를 확인한다.
   *      전달 완료를 기록하는 쪽(결과 배치)이 같은 행을 UPDATE 하므로, 잠금 하의 판정은
   *      "이 트랜잭션이 커밋되는 순간까지 미전달"을 보장한다(§3 나 경쟁 차단).
   *   ② 원 시도를 `RETRY_SCHEDULED → RETRIED` 조건부 갱신한다(다른 worker 선점 시 중단).
   *   ③ `retryOfAttemptId` 로 연결된 신규 시도(`OUTBOX_READY`)를 생성한다.
   * `(rootAttemptId, 'AUTO_504')` DB unique 위반 시 트랜잭션 전체가 롤백된다(체인당 1회 최종 강제).
   */
  private async createRetriedChild(
    origin: MessageAttemptEntity,
    workflow: DeliveryWorkflowEntity,
    gate: ResendGate,
    now: Date,
  ): Promise<MessageAttemptEntity | typeof DELIVERED | null> {
    return await this.dataSource.transaction(async (manager) => {
      const locked = await manager.getRepository(DeliveryWorkflowEntity).findOne({
        where: { orderDeliveryId: origin.orderDeliveryId },
        lock: { mode: 'pessimistic_write' },
      });
      if (locked?.deliveredFlag) {
        return DELIVERED;
      }

      const repo = manager.getRepository(MessageAttemptEntity);
      const retired = await repo.update(
        { attemptId: origin.attemptId, status: MessageAttemptStatus.RETRY_SCHEDULED },
        { status: MessageAttemptStatus.RETRIED, resolvedAt: now, stateEnteredAt: now },
      );
      if (!retired.affected) {
        return null;
      }

      const isSlot = gate.kind === 'slot';
      return await repo.save(
        repo.create({
          attemptId: generateAttemptId(),
          orderDeliveryId: origin.orderDeliveryId,
          channel: origin.channel,
          attemptType: MessageAttemptType.AUTO_504,
          attemptSeq: origin.attemptSeq + 1,
          retryOfAttemptId: origin.attemptId,
          rootAttemptId: origin.rootAttemptId,
          status: MessageAttemptStatus.OUTBOX_READY,
          sendReason: 'AUTO_504_RESEND',
          // 크래시 후 재개(OUTBOX_READY 정체)에도 기한 판정이 유지되도록 원 시도의 기한을 상속한다(§7.2).
          retryDeadlineAt: origin.retryDeadlineAt,
          ownerToken: isSlot ? gate.slot.ownerToken : null,
          workflowVersion: isSlot ? gate.slot.workflowVersion : null,
          // legacy 건을 RETRY 로 기록하면 §10 불변식 ②가 legacy 정상 동작을 위반으로 집계한다.
          createdByOp: isSlot ? DeliveryExclusiveOp.RETRY : LEGACY_SEND_OP,
          createdWorkflowVersion: isSlot ? gate.slot.workflowVersion : String(workflow.workflowVersion),
          stateEnteredAt: now,
        }),
      );
    });
  }

  /** 타 채널 전달 완료 — 미확정 예약·정체 자식을 취소 종결한다(실패·환불 후보 아님, §3 나). */
  private async supersede(attempt: MessageAttemptEntity, now: Date): Promise<boolean> {
    const result = await this.attemptRepository.update(
      { attemptId: attempt.attemptId, status: attempt.status },
      { status: MessageAttemptStatus.CANCELLED_SUPERSEDED, resolvedAt: now, stateEnteredAt: now },
    );
    return !!result.affected;
  }

  /** 실행 시점 기한 초과 — 재발송 없이 최종 실패로 종결한다(§7.2, 기한 예외 승인 절차 없음). */
  private async expire(attempt: MessageAttemptEntity, now: Date): Promise<void> {
    const result = await this.attemptRepository.update(
      { attemptId: attempt.attemptId, status: attempt.status },
      { status: MessageAttemptStatus.FAILED_FINAL, resolvedAt: now, stateEnteredAt: now },
    );
    if (result.affected) {
      await this.reconcileService.markWorkflowFailedIfSettled(attempt.orderDeliveryId, now);
    }
  }

  /**
   * 동시성 게이트 획득(§9 단일 동시성 모델 원칙).
   * - 전환 건: Level A `RETRY` 슬롯. due 실행은 기본 가드(도래한 RETRY_SCHEDULED EXISTS + 미확정 부재),
   *   `OUTBOX_READY` 재개는 **재개 변형 가드**(`retryResume` — 정체 AUTO_504 EXISTS + 그 외 미확정 부재)로 점유한다.
   * - 미전환 건: 기존 `claimedAt`/`mutationClaimedAt` 원자 CAS(발송배치·CS 재발송과 동일 모델).
   */
  private async acquireGate(
    workflow: DeliveryWorkflowEntity,
    orderDeliveryId: number,
    now: Date,
    retryResume: boolean,
  ): Promise<ResendGate | null> {
    if (workflow.cutoverMigratedAt) {
      const acquired = await this.slotService.acquire({
        orderDeliveryId,
        op: DeliveryExclusiveOp.RETRY,
        retryResume,
        now,
      });
      if (!acquired.acquired) {
        this.logger.warn(`[DUE_RESEND] RETRY 슬롯 점유 실패(${acquired.code}). orderDeliveryId=${orderDeliveryId}`);
        return null;
      }
      return { kind: 'slot', slot: acquired.slot };
    }

    const claimAt = new Date(now.getTime());
    const stale = new Date(claimAt.getTime() - MUTATION_CLAIM_STALE_MS);
    const result = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ claimedAt: claimAt, mutationClaimedAt: claimAt })
      .where('id = :id', { id: orderDeliveryId })
      .andWhere('deleted_at IS NULL')
      .andWhere('(claimedAt IS NULL OR claimedAt < :stale)', { stale })
      .andWhere('(mutation_claimed_at IS NULL OR mutation_claimed_at < :stale)', { stale })
      // 이미 폐기·환불된 쿠폰은 재발송하지 않는다(죽은 핀 배달 방지 — 발송 경로 공통 게이트).
      .andWhere('(coupon_status IS NULL OR coupon_status NOT IN (:...unsendable))', {
        unsendable: UNSENDABLE_COUPON_STATUSES,
      })
      .andWhere('refunded_at IS NULL')
      .andWhere('refund_status IS NULL')
      // 컷오버 드레이닝·전환 건은 legacy 게이트를 잡지 못한다. 위 cutoverMigratedAt 분기는 읽기 판정이라
      // 그 사이 마크가 서면 늦게 도착한다 — 점유와 같은 문장에 술어를 넣어 원자화한다(§9 quiesce).
      .andWhere(NOT_CUTOVER_ORDER_DELIVERY)
      .execute();

    if (!result.affected) {
      return null;
    }
    return { kind: 'legacy', claimAt };
  }

  /** 게이트 해제 — 자기 토큰으로만 푼다(남의 활성 lease/슬롯을 지우지 않는다). */
  private async releaseGate(orderDeliveryId: number, gate: ResendGate): Promise<void> {
    if (gate.kind === 'slot') {
      try {
        await this.slotService.release(gate.slot);
      } catch (e) {
        this.logger.error(`[DUE_RESEND] 슬롯 해제 실패. orderDeliveryId=${orderDeliveryId}: ${e}`);
      }
      return;
    }

    // claimedAt 해제와 변형 lease 해제를 한 update 로 합치지 않는다 — 한쪽만 stale 로 빼앗긴 경우
    // 남의 활성 lease 를 지우게 된다(CS 재발송과 동일 원칙). 해제 실패는 5분 stale self-heal 에 맡긴다.
    try {
      await this.orderDeliveryRepository.update({ id: orderDeliveryId, claimedAt: gate.claimAt }, { claimedAt: null });
    } catch (e) {
      this.logger.error(`[DUE_RESEND] claimedAt 해제 실패. orderDeliveryId=${orderDeliveryId}: ${e}`);
    }
    try {
      await this.orderDeliveryRepository.update(
        { id: orderDeliveryId, mutationClaimedAt: gate.claimAt },
        { mutationClaimedAt: null },
      );
    } catch (e) {
      this.logger.error(`[DUE_RESEND] 변형 lease 해제 실패. orderDeliveryId=${orderDeliveryId}: ${e}`);
    }
  }
}
