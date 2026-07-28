import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { MessageAttemptEntity } from '../../entity/message.attempt.entity';
import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import { MessageAttemptStatus, MessageAttemptType } from '../interface/message.attempt.status';
import { DeliveryWorkflowStatus, OpsReviewReason } from '../interface/delivery.workflow.status';
import { GemtekResultQuery, GemtekResultRecord } from '../../sms/infra/gemtek.result.query';
import { SmsGemtekSend } from '../../sms/infra/sms.gemtek.send';
import { classifyGemtekResult, GemtekResultOutcome } from '../domain/gemtek.result.policy';
import { advanceCursor, monthsToSearch, toYearMonth } from '../domain/result.partition.cursor';
import {
  computeNextAttemptAt,
  computeResendDeadline,
  isWithinResendDeadline,
  RESEND_DEADLINE_MS,
} from '../domain/resend.schedule';

/** 표 4-1 상태별 최대 체류시간(제안값, §7.1). 승인 확정 시 이 상수를 바꾼다. */
export const SLA_SUBMITTING_MS = 5 * 60 * 1000;
export const SLA_SUBMITTED_MS = 30 * 60 * 1000;
export const SLA_RECONCILING_MS = 2 * 60 * 60 * 1000;
export const SLA_TRACKING_MS = 30 * 60 * 60 * 1000;
export const SLA_UNKNOWN_MS = 30 * 60 * 60 * 1000;
export const SLA_OUTBOX_READY_MS = 5 * 60 * 1000;

/** 최대 추적·보존 기간(§7 표 4). 초과 시 재조회를 멈추고 운영 종결로 넘긴다. */
export const MAX_TRACKING_MS = 90 * 24 * 60 * 60 * 1000;

/** 한 사이클에서 처리할 attempt 수 상한(결과 테이블 부하 제어). */
const RECONCILE_BATCH_SIZE = 200;

export interface ReconcileSummary {
  scanned: number;
  succeeded: number;
  failed: number;
  retryScheduled: number;
  unknown: number;
  pending: number;
  recovered: number;
  /** UNKNOWN 승격 후 지연 확정 결과가 도착해 LATE_RESULT_REVIEW 로 기록된 건수(§7.1) */
  lateResult: number;
}

export interface SlaSweepSummary {
  toReconciling: number;
  toUnknown: number;
  escalated: number;
  expiredResend: number;
  stuckOutbox: number;
}

/**
 * Gemtek 결과 조회·재조정 배치 (§4 코드 정책 / §7.1 SLA / §7.3 증분 탐색).
 *
 * - insert 성공은 발송 성공이 아니라 **추적 중**이다. `(STAT,RESULT)` 가 확정될 때까지 조회한다.
 * - 조회는 확정월 파티션을 **증분 범위만** 훑는다(전체 월 스캔 금지).
 * - **자동 재발송은 §10 4단계 canary 전까지 비활성**이다. 504 확정도 기본은 `FAILED_FINAL` 이며,
 *   `DELIVERY_AUTO_RESEND_504_ENABLED=true` 일 때만 `RETRY_SCHEDULED` 로 예약한다.
 * - 25시간은 자동 성공 판정 시점이 아니다. 미확정은 성공으로 추정하지 않고 SLA 초과 시
 *   `UNKNOWN` + `OPS_REVIEW_REQUIRED` 로 넘기며, 조회는 보존 한도까지 계속한다.
 */
@Injectable()
export class MessageResultReconcileService {
  private readonly logger = new Logger(MessageResultReconcileService.name);

  constructor(
    @InjectRepository(MessageAttemptEntity)
    private readonly attemptRepository: Repository<MessageAttemptEntity>,
    @InjectRepository(DeliveryWorkflowEntity)
    private readonly workflowRepository: Repository<DeliveryWorkflowEntity>,
    private readonly gemtekResultQuery: GemtekResultQuery,
    private readonly smsGemtekSend: SmsGemtekSend,
    private readonly configService: ConfigService,
  ) {}

  /** 504 자동 재발송 활성화 여부(§10 4단계 canary). 기본 비활성. */
  private get auto504Enabled(): boolean {
    return this.configService.get('DELIVERY_AUTO_RESEND_504_ENABLED') === 'true';
  }

  /** 추적 중 시도의 결과를 조회해 반영한다. */
  async reconcileOnce(now: Date = new Date(), limit: number = RECONCILE_BATCH_SIZE): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      scanned: 0,
      succeeded: 0,
      failed: 0,
      retryScheduled: 0,
      unknown: 0,
      pending: 0,
      recovered: 0,
      lateResult: 0,
    };

    const tracking = await this.attemptRepository.find({
      where: { status: MessageAttemptStatus.TRACKING, mseq: Not(IsNull()) },
      order: { stateEnteredAt: 'ASC' },
      take: limit,
    });

    for (const attempt of tracking) {
      summary.scanned++;
      try {
        await this.reconcileTracking(attempt, now, summary);
      } catch (e) {
        this.logger.error(`결과 조회 실패(다음 사이클 재시도). attemptId=${attempt.attemptId}: ${e}`);
      }
    }

    // 응답 유실·fencing 불일치로 재조정 중인 시도는 상관키로만 복구한다(추정 금지, §3 다).
    const reconciling = await this.attemptRepository.find({
      where: { status: MessageAttemptStatus.RECONCILING },
      order: { stateEnteredAt: 'ASC' },
      take: limit,
    });

    for (const attempt of reconciling) {
      summary.scanned++;
      try {
        if (await this.recoverReconciling(attempt, now)) {
          summary.recovered++;
        }
      } catch (e) {
        this.logger.error(`재조정 복구 실패(다음 사이클 재시도). attemptId=${attempt.attemptId}: ${e}`);
      }
    }

    // **UNKNOWN·OPS 승격 건도 보존 한도(90일)까지 조회 대상이다(§7.1·§7.3).**
    // 승격은 정산 보류·운영 배정 신호일 뿐 조회 중단 신호가 아니다. 다만 늦게 도착한 확정 결과로
    // 자동 종결·자동 정산 정정을 하지 않고 `LATE_RESULT_REVIEW` 로 기록만 한다.
    const unknown = await this.attemptRepository.find({
      // `MSEQ` 유무로 거르지 않는다 — 재조정 중 SLA 초과로 승격된 건은 `MSEQ` 가 없고,
      // 그 결과는 상관키(`EXT_COL2`)로만 찾을 수 있다. 걸러내면 90일 동안 영원히 못 본다.
      where: { status: MessageAttemptStatus.UNKNOWN, lateResultAt: IsNull() },
      order: { stateEnteredAt: 'ASC' },
      take: limit,
    });

    for (const attempt of unknown) {
      summary.scanned++;
      try {
        if (await this.reviewLateResult(attempt, now)) {
          summary.lateResult++;
        }
      } catch (e) {
        this.logger.error(`지연 결과 조회 실패(다음 사이클 재시도). attemptId=${attempt.attemptId}: ${e}`);
      }
    }

    return summary;
  }

  /** `MSEQ` 로 확정월 파티션을 증분 탐색한다(§7.3). */
  private async reconcileTracking(attempt: MessageAttemptEntity, now: Date, summary: ReconcileSummary): Promise<void> {
    if (now.getTime() - attempt.createdAt.getTime() > MAX_TRACKING_MS) {
      // 보존 한도 종료 파티션은 재조회하지 않는다. 자동 성공·실패로 단정하지 않고 운영 종결로 넘긴다.
      await this.markUnknown(attempt, now, OpsReviewReason.SLA_EXCEEDED);
      summary.unknown++;
      return;
    }

    const currentMonth = toYearMonth(now);
    const startMonth = attempt.nextSearchMonth ?? attempt.receiptMonth ?? toYearMonth(attempt.createdAt);

    for (const month of monthsToSearch(startMonth, currentMonth)) {
      const row = await this.gemtekResultQuery.findByMseq(month, attempt.mseq!);
      if (!row) {
        continue;
      }

      await this.applyResult(attempt, row, now, summary);
      return;
    }

    // 미확정: 닫힌 과거월은 다시 보지 않고 현재월만 다음 사이클에 재조회한다.
    const cursor = advanceCursor(currentMonth);
    await this.attemptRepository.update(
      { attemptId: attempt.attemptId, status: MessageAttemptStatus.TRACKING },
      { lastSearchedMonth: cursor.lastSearchedMonth, nextSearchMonth: cursor.nextSearchMonth },
    );
    summary.pending++;
  }

  /** `(STAT, RESULT)` 판정을 attempt·workflow 에 반영한다(§4). */
  private async applyResult(
    attempt: MessageAttemptEntity,
    row: GemtekResultRecord,
    now: Date,
    summary: ReconcileSummary,
  ): Promise<void> {
    const outcome = classifyGemtekResult(row);
    const confirmedAt = row.reportTime ?? now;
    const raw = {
      gemtekStat: row.stat,
      gemtekResult: row.result,
      sendTime: row.sendTime,
      reportTime: row.reportTime,
    };

    if (outcome === GemtekResultOutcome.UNKNOWN) {
      if (row.stat !== '3') {
        // 아직 확정 전이다. 상태를 바꾸지 않고 다음 사이클에 다시 본다.
        summary.pending++;
        return;
      }
      // 확정됐지만 전달 여부가 불명(519)이거나 미분류 코드 → 자동 종결 금지, 운영 확인.
      await this.markUnknown(attempt, now, OpsReviewReason.SLA_EXCEEDED, raw);
      summary.unknown++;
      return;
    }

    if (outcome === GemtekResultOutcome.SUCCEEDED) {
      await this.transition(attempt, MessageAttemptStatus.TRACKING, MessageAttemptStatus.SUCCEEDED, {
        ...raw,
        resolvedAt: confirmedAt,
      });
      await this.markDelivered(attempt, confirmedAt);
      summary.succeeded++;
      return;
    }

    if (outcome === GemtekResultOutcome.RETRYABLE_504 && this.canScheduleAutoResend(attempt, confirmedAt, now)) {
      await this.transition(attempt, MessageAttemptStatus.TRACKING, MessageAttemptStatus.RETRY_SCHEDULED, {
        ...raw,
        nextAttemptAt: computeNextAttemptAt(confirmedAt),
        // 기한은 **확정 시각 기준**으로 고정 저장한다(예약 시각 기준이 아니다, §7.2).
        retryDeadlineAt: computeResendDeadline(confirmedAt),
      });
      summary.retryScheduled++;
      return;
    }

    // 확정 실패(520/505/503/203) 또는 자동 재발송 비활성 상태의 504.
    await this.transition(attempt, MessageAttemptStatus.TRACKING, MessageAttemptStatus.FAILED_FINAL, {
      ...raw,
      resolvedAt: confirmedAt,
    });
    await this.markWorkflowFailedIfSettled(attempt.orderDeliveryId, confirmedAt);
    summary.failed++;
  }

  /**
   * 504 자동 재발송 예약 가능 여부.
   *
   * 활성 플래그(§10 4단계) + **최초 시도에서만** 트리거 + 체인당 1회(DB unique 가 최종 강제) +
   * 재발송 가능 기한(504 확정 + 24h) 안이어야 한다. 재발송 자식이 다시 504면 즉시 `FAILED_FINAL` 이다.
   */
  private canScheduleAutoResend(attempt: MessageAttemptEntity, confirmedAt: Date, now: Date): boolean {
    if (!this.auto504Enabled) {
      return false;
    }
    if (attempt.retryOfAttemptId !== null || attempt.attemptType !== MessageAttemptType.INITIAL) {
      return false;
    }
    return isWithinResendDeadline(confirmedAt, now);
  }

  /**
   * `UNKNOWN` 으로 승격된 시도의 **지연 확정 결과**를 확인한다(§7.1 `LATE_RESULT_REVIEW`).
   *
   * 승격은 조회 중단 신호가 아니므로 보존 한도(90일)까지 계속 훑는다. 다만 늦게 도착한 결과로
   * **자동 성공·실패·정산 정정을 하지 않는다** — 원본 코드와 도착 시각만 기록하고 운영 확인
   * (`DUAL_APPROVAL`)으로 넘긴다. 한 번 기록한 뒤에는 `late_result_at` 로 재기록을 막는다.
   */
  private async reviewLateResult(attempt: MessageAttemptEntity, now: Date): Promise<boolean> {
    if (now.getTime() - attempt.createdAt.getTime() > MAX_TRACKING_MS) {
      // 보존 한도 종료 파티션은 재조회하지 않는다(§7.3). 상태는 이미 UNKNOWN·운영 승격이다.
      return false;
    }

    const currentMonth = toYearMonth(now);
    const startMonth = attempt.nextSearchMonth ?? attempt.receiptMonth ?? toYearMonth(attempt.createdAt);

    for (const month of monthsToSearch(startMonth, currentMonth)) {
      // `MSEQ` 를 확보하지 못한 채 승격된 건(재조정 중 SLA 초과)도 조회 대상이다.
      // 그런 건은 상관키(`EXT_COL2`)로만 찾을 수 있으므로 조회 키를 상태에 맞게 고른다.
      const row = attempt.mseq
        ? await this.gemtekResultQuery.findByMseq(month, attempt.mseq)
        : await this.gemtekResultQuery.findByAttemptId(month, attempt.attemptId);
      if (!row || row.stat !== '3') {
        continue;
      }

      await this.attemptRepository.update(
        { attemptId: attempt.attemptId, status: MessageAttemptStatus.UNKNOWN },
        {
          // 상관키로 찾은 건은 이제 `MSEQ` 를 알게 됐으므로 함께 남긴다(이후 조회·운영 확인 근거).
          mseq: attempt.mseq ?? String(row.mseq),
          gemtekStat: row.stat,
          gemtekResult: row.result,
          sendTime: row.sendTime,
          reportTime: row.reportTime,
          lateResultAt: now,
        },
      );
      await this.markLateResultReview(attempt.orderDeliveryId, now);
      this.logger.warn(
        `[LATE_RESULT_REVIEW] 지연 확정 도착 — 자동 종결하지 않는다. ` +
          `attemptId=${attempt.attemptId}, mseq=${attempt.mseq ?? row.mseq}, stat=${row.stat}, result=${row.result}`,
      );
      return true;
    }

    // 아직 확정 전이다. 커서만 전진시키고 다음 사이클에 다시 본다.
    const cursor = advanceCursor(currentMonth);
    await this.attemptRepository.update(
      { attemptId: attempt.attemptId, status: MessageAttemptStatus.UNKNOWN },
      { lastSearchedMonth: cursor.lastSearchedMonth, nextSearchMonth: cursor.nextSearchMonth },
    );
    return false;
  }

  /**
   * 지연 결과를 운영 재검토 대상으로 올린다(§6.3 `lateResult` 행).
   * `FAILED_FINAL` 은 `OPS_REVIEW_REQUIRED` 로 재상정하고, 이미 승격됐으면 사유만 갱신한다.
   * `RESOLVED_MANUALLY_*`·`COMPLETED`·`CANCELLED` 는 불변·정합 상태라 건드리지 않는다(감사 기록만).
   */
  private async markLateResultReview(orderDeliveryId: number, now: Date): Promise<void> {
    await this.workflowRepository
      .createQueryBuilder()
      .update(DeliveryWorkflowEntity)
      .set({
        workflowStatus: DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
        opsEscalatedAt: now,
        opsReviewReason: OpsReviewReason.LATE_RESULT_REVIEW,
        stateEnteredAt: now,
        workflowVersion: () => 'workflow_version + 1',
      })
      .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId })
      .andWhere('workflow_status IN (:...reviewable)', {
        reviewable: [
          DeliveryWorkflowStatus.IN_PROGRESS,
          DeliveryWorkflowStatus.PENDING_RECONCILE,
          DeliveryWorkflowStatus.FAILED_FINAL,
          DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
        ],
      })
      .execute();
  }

  /**
   * 재조정 중 시도를 상관키로 복구한다. 큐에 남아 있으면 `MSEQ` 를 되찾고 추적을 재개한다.
   * 0건·복수·조회 실패는 여기서 종결하지 않고 SLA sweep 이 `UNKNOWN` 으로 넘긴다(성급한 종결 방지).
   */
  private async recoverReconciling(attempt: MessageAttemptEntity, now: Date): Promise<boolean> {
    if (attempt.cancelRequestedAt) {
      // 취소 의도 보유 건의 재개는 CANCEL_INFLIGHT_SEND op 소관이다(§6.3). 컷오버 슬라이스에서 처리한다.
      return false;
    }

    const queueMseq = attempt.mseq
      ? Number(attempt.mseq)
      : await this.smsGemtekSend.findMseqByAttemptId(attempt.attemptId);
    if (queueMseq !== null) {
      await this.transition(attempt, MessageAttemptStatus.RECONCILING, MessageAttemptStatus.TRACKING, {
        mseq: String(queueMseq),
        receiptMonth: attempt.receiptMonth ?? toYearMonth(attempt.createdAt),
        nextSearchMonth: attempt.nextSearchMonth ?? toYearMonth(attempt.createdAt),
      });
      return true;
    }

    // 큐에서 사라졌다면 이미 결과로 이관됐을 수 있다 — 상관키로 결과 파티션을 훑는다.
    const currentMonth = toYearMonth(now);
    const startMonth = attempt.nextSearchMonth ?? attempt.receiptMonth ?? toYearMonth(attempt.createdAt);

    for (const month of monthsToSearch(startMonth, currentMonth)) {
      const row = await this.gemtekResultQuery.findByAttemptId(month, attempt.attemptId);
      if (!row) {
        continue;
      }

      await this.transition(attempt, MessageAttemptStatus.RECONCILING, MessageAttemptStatus.TRACKING, {
        mseq: String(row.mseq),
        receiptMonth: attempt.receiptMonth ?? month,
        nextSearchMonth: month,
      });
      return true;
    }

    return false;
  }

  /** 표 4-1 최대 체류시간 초과 건을 강제 전이한다(§7.1). */
  async sweepSlaOnce(now: Date = new Date()): Promise<SlaSweepSummary> {
    const summary: SlaSweepSummary = {
      toReconciling: 0,
      toUnknown: 0,
      escalated: 0,
      expiredResend: 0,
      stuckOutbox: 0,
    };

    // 발급 여부 불명 구간 → 재조회만 허용(blind 재삽입 금지).
    summary.toReconciling += await this.forceStatus(
      [MessageAttemptStatus.SUBMITTING],
      new Date(now.getTime() - SLA_SUBMITTING_MS),
      MessageAttemptStatus.RECONCILING,
      now,
    );
    summary.toReconciling += await this.forceStatus(
      [MessageAttemptStatus.SUBMITTED],
      new Date(now.getTime() - SLA_SUBMITTED_MS),
      MessageAttemptStatus.RECONCILING,
      now,
    );

    // 재조정·추적 SLA 초과 → UNKNOWN(자동 성공/실패 단정 금지) + 운영 승격.
    const unknownTargets = [
      { statuses: [MessageAttemptStatus.RECONCILING], before: new Date(now.getTime() - SLA_RECONCILING_MS) },
      { statuses: [MessageAttemptStatus.TRACKING], before: new Date(now.getTime() - SLA_TRACKING_MS) },
    ];

    for (const target of unknownTargets) {
      const attempts = await this.attemptRepository.find({
        where: { status: In(target.statuses), stateEnteredAt: LessThan(target.before) },
        take: RECONCILE_BATCH_SIZE,
      });
      for (const attempt of attempts) {
        await this.markUnknown(attempt, now, OpsReviewReason.SLA_EXCEEDED);
        summary.toUnknown++;
        summary.escalated++;
      }
    }

    // UNKNOWN 인데 아직 승격되지 않은 건도 운영 배정으로 올린다(조회는 계속한다).
    const staleUnknown = await this.attemptRepository.find({
      where: {
        status: MessageAttemptStatus.UNKNOWN,
        stateEnteredAt: LessThan(new Date(now.getTime() - SLA_UNKNOWN_MS)),
      },
      take: RECONCILE_BATCH_SIZE,
    });
    for (const attempt of staleUnknown) {
      if (await this.escalateWorkflow(attempt.orderDeliveryId, now, OpsReviewReason.SLA_EXCEEDED)) {
        summary.escalated++;
      }
    }

    // 예약 재발송의 기한 초과 → FAILED_FINAL(기한 예외 승인 절차 없음, §7.2).
    //
    // 기준은 **실패 확정 시각 + 24h(`retry_deadline_at`)** 이다. `next_attempt_at` 기준으로 재면
    // 심야 확정분이 익일 08:00 예약 + 체류시간만큼 더 살아남아 기한을 넘긴 재발송이 나갈 수 있다.
    // 기한 컬럼이 없는 과거 행은 `next_attempt_at + 24h` 로 보수적으로 만료시킨다.
    const expired = await this.attemptRepository
      .createQueryBuilder('ma')
      .where('ma.status = :status', { status: MessageAttemptStatus.RETRY_SCHEDULED })
      .andWhere(
        `((ma.retry_deadline_at IS NOT NULL AND ma.retry_deadline_at < :now)
           OR (ma.retry_deadline_at IS NULL AND ma.next_attempt_at IS NOT NULL AND ma.next_attempt_at < :legacyCutoff))`,
        { now, legacyCutoff: new Date(now.getTime() - RESEND_DEADLINE_MS) },
      )
      .take(RECONCILE_BATCH_SIZE)
      .getMany();

    for (const attempt of expired) {
      await this.transition(attempt, MessageAttemptStatus.RETRY_SCHEDULED, MessageAttemptStatus.FAILED_FINAL, {
        resolvedAt: now,
      });
      await this.markWorkflowFailedIfSettled(attempt.orderDeliveryId, now);
      summary.expiredResend++;
    }

    // OUTBOX_READY 정체는 "외부 호출 전"이 확정이라 재개 대상이다(§5.3). 재개 실행자는 컷오버
    // 슬라이스에서 도입하므로 여기서는 상태를 바꾸지 않고 관측만 한다(임의 종결 금지).
    summary.stuckOutbox = await this.attemptRepository.count({
      where: {
        status: MessageAttemptStatus.OUTBOX_READY,
        stateEnteredAt: LessThan(new Date(now.getTime() - SLA_OUTBOX_READY_MS)),
      },
    });
    if (summary.stuckOutbox > 0) {
      this.logger.warn(`[TRACKING_SLA] OUTBOX_READY 정체 ${summary.stuckOutbox}건 — 재개 실행자 도입 전까지 관측만`);
    }

    return summary;
  }

  /** 상태 전이는 항상 현재 상태를 조건으로 건다(경쟁 시 남의 확정을 덮지 않는다). */
  private async transition(
    attempt: MessageAttemptEntity,
    from: MessageAttemptStatus,
    to: MessageAttemptStatus,
    patch: Partial<MessageAttemptEntity> = {},
  ): Promise<boolean> {
    const result = await this.attemptRepository.update(
      { attemptId: attempt.attemptId, status: from },
      { ...patch, status: to, stateEnteredAt: new Date() },
    );
    return !!result.affected;
  }

  /** attempt 를 `UNKNOWN` 으로 남기고 workflow 를 운영 확인으로 승격한다. */
  private async markUnknown(
    attempt: MessageAttemptEntity,
    now: Date,
    reason: OpsReviewReason,
    patch: Partial<MessageAttemptEntity> = {},
  ): Promise<void> {
    await this.transition(attempt, attempt.status, MessageAttemptStatus.UNKNOWN, patch);
    await this.escalateWorkflow(attempt.orderDeliveryId, now, reason);
  }

  /**
   * workflow 를 `OPS_REVIEW_REQUIRED` 로 승격한다. 종결·수동 종결 상태는 건드리지 않는다
   * (`RESOLVED_MANUALLY_*` 는 불변 override, §7.1).
   */
  private async escalateWorkflow(orderDeliveryId: number, now: Date, reason: OpsReviewReason): Promise<boolean> {
    const result = await this.workflowRepository
      .createQueryBuilder()
      .update(DeliveryWorkflowEntity)
      .set({
        workflowStatus: DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
        opsEscalatedAt: now,
        opsReviewReason: reason,
        stateEnteredAt: now,
        workflowVersion: () => 'workflow_version + 1',
      })
      .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId })
      .andWhere('workflow_status IN (:...open)', {
        open: [DeliveryWorkflowStatus.IN_PROGRESS, DeliveryWorkflowStatus.PENDING_RECONCILE],
      })
      .execute();

    return !!result.affected;
  }

  /** 쿠폰 전달 완료 표식(§3 나 — 한 채널이라도 최종 성공하면 전달 완료). */
  private async markDelivered(attempt: MessageAttemptEntity, deliveredAt: Date): Promise<void> {
    await this.workflowRepository
      .createQueryBuilder()
      .update(DeliveryWorkflowEntity)
      .set({
        deliveredFlag: true,
        deliveredChannel: attempt.channel,
        deliveredAt,
        workflowStatus: DeliveryWorkflowStatus.COMPLETED,
        stateEnteredAt: deliveredAt,
        workflowVersion: () => 'workflow_version + 1',
      })
      .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId: attempt.orderDeliveryId })
      .andWhere('workflow_status IN (:...open)', {
        open: [DeliveryWorkflowStatus.IN_PROGRESS, DeliveryWorkflowStatus.PENDING_RECONCILE],
      })
      .execute();
  }

  /**
   * 남은 미확정 시도가 없을 때만 workflow 를 `FAILED_FINAL` 로 확정한다.
   * 하나라도 미확정이면 완료·정산·환불을 막는 `PENDING_RECONCILE` 로 둔다(§5.1).
   *
   * 재발송 실행기(`dueResend`)의 기한 초과 종결도 같은 규칙을 써야 하므로 public 이다.
   */
  async markWorkflowFailedIfSettled(orderDeliveryId: number, now: Date): Promise<void> {
    const pending = await this.attemptRepository.count({
      where: {
        orderDeliveryId,
        status: In([
          MessageAttemptStatus.OUTBOX_READY,
          MessageAttemptStatus.SUBMITTING,
          MessageAttemptStatus.SUBMITTED,
          MessageAttemptStatus.TRACKING,
          MessageAttemptStatus.RECONCILING,
          MessageAttemptStatus.RETRY_SCHEDULED,
          MessageAttemptStatus.UNKNOWN,
        ]),
      },
    });

    const nextStatus = pending > 0 ? DeliveryWorkflowStatus.PENDING_RECONCILE : DeliveryWorkflowStatus.FAILED_FINAL;

    await this.workflowRepository
      .createQueryBuilder()
      .update(DeliveryWorkflowEntity)
      .set({ workflowStatus: nextStatus, stateEnteredAt: now, workflowVersion: () => 'workflow_version + 1' })
      .where('order_delivery_id = :orderDeliveryId', { orderDeliveryId })
      .andWhere('workflow_status IN (:...open)', {
        open: [DeliveryWorkflowStatus.IN_PROGRESS, DeliveryWorkflowStatus.PENDING_RECONCILE],
      })
      .execute();
  }

  /** 지정 상태에서 체류시간을 초과한 건을 다른 상태로 강제 전이한다. */
  private async forceStatus(
    from: MessageAttemptStatus[],
    before: Date,
    to: MessageAttemptStatus,
    now: Date,
  ): Promise<number> {
    const result = await this.attemptRepository
      .createQueryBuilder()
      .update(MessageAttemptEntity)
      .set({ status: to, stateEnteredAt: now })
      .where('status IN (:...from)', { from })
      .andWhere('state_entered_at < :before', { before })
      .execute();

    return result.affected ?? 0;
  }
}
