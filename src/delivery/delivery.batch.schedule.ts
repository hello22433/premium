// 요청시각에 따른 전송 배치

import { DeliveryBatchService } from './application/delivery.batch.service';
import { SsgRecoverySweepService } from './application/ssg-recovery-sweep.service';
import { SsgResendDeductRecoveryService } from './application/ssg-resend-deduct-recovery.service';
import { MessageResultReconcileService } from './application/message-result-reconcile.service';
import { MessageResendExecutorService } from './application/message-resend-executor.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

/**
 * cron 중복 실행 차단용 max runtime (ms).
 * 정상 종료가 실패해 플래그가 영구히 true로 남는 dead-man's switch.
 * 30분 안에 안 끝나는 batch는 비정상으로 간주하고 다음 cron이 강제로 진입한다.
 */
const MAX_BATCH_RUNTIME_MS = 30 * 60 * 1000;

@Injectable()
export class DeliveryBatchSchedule {
  constructor(
    private deliveryBatchService: DeliveryBatchService,
    private ssgRecoverySweepService: SsgRecoverySweepService,
    private ssgResendDeductRecoveryService: SsgResendDeductRecoveryService,
    private messageResultReconcileService: MessageResultReconcileService,
    private messageResendExecutorService: MessageResendExecutorService,
  ) {}

  // 부팅 stale claim 해제는 main.ts(listen() 전)에서만 수행한다. lifecycle 훅은 migration
  // 스크립트 등 standalone bootstrap 에서도 발화해 살아있는 claim 을 해제할 위험이 있다.

  private logger = new Logger('BATCH');

  // cron 중복 실행 차단 플래그. 이전 batch가 진행 중이면 다음 cron은 즉시 return하여
  // claim 쿼리와 진행 중 save 쿼리 사이 데드락을 차단한다.
  private issueAndSendStartedAt: number | null = null;
  private statusUpdateStartedAt: number | null = null;
  private encourageStartedAt: number | null = null;
  private ssgRecoverySweepStartedAt: number | null = null;
  private resendDeductSweepStartedAt: number | null = null;
  private reportSweepStartedAt: number | null = null;
  private resultReconcileStartedAt: number | null = null;
  private trackingSlaStartedAt: number | null = null;
  private dueResendStartedAt: number | null = null;

  /**
   * 실행 중 플래그를 체크한다. 진행 중이면 true 반환(skip).
   * max runtime 초과 시 stale로 간주하고 플래그를 풀어 다음 cron이 진입할 수 있게 한다.
   */
  private isStillRunning(startedAt: number | null, label: string): boolean {
    if (startedAt === null) return false;
    const elapsed = Date.now() - startedAt;
    if (elapsed > MAX_BATCH_RUNTIME_MS) {
      this.logger.warn(
        `[BATCH] ${label} max runtime(${MAX_BATCH_RUNTIME_MS / 1000}s) 초과 — stale 플래그 해제 후 진입`,
      );
      return false;
    }
    return true;
  }

  // 발송 배치 — **09:00~20:00 KST 에만** 5분 간격으로 실행한다(2026-07-27 운영 확정).
  //
  //   주문 작성의 예약발송 선택 시간대가 이미 심야를 배제하므로 그 밖의 시간에 발송 배치를 돌릴
  //   이유가 없고, 예약 시각 오입력·데이터 이상으로 새벽에 문자가 나가면 광고성 정보 전송 제한
  //   위반 위험이 있다. 마지막 실행은 19:55 이며, 그 시각 이후 도래분은 다음 날 09:00 에 나간다.
  //   (운영자 수동 재발송·CS 재발송은 사람이 판단하는 행위라 이 제한의 대상이 아니다.)
  @Cron('0 */5 9-19 * * *', { timeZone: 'Asia/Seoul' })
  async issueAndSend() {
    if (this.isStillRunning(this.issueAndSendStartedAt, 'issueAndSend')) {
      this.logger.log('[BATCH] 이전 issueAndSend 진행 중 — skip');
      return;
    }
    this.issueAndSendStartedAt = Date.now();
    try {
      await this.deliveryBatchService.issueAndSend();
      this.logger.log('Complete Delivery');
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.issueAndSendStartedAt = null;
    }
  }

  // 알림톡 비동기 수신확인 sweep. 30초마다(매분 7,37초 — 다른 cron 의 0/15/30/45초와 충돌 회피).
  // PENDING 리포트 inquiry 30초×2 근사 + 미확정 시 SMS 자동 재발송 1회.
  @Cron('7,37 * * * * *')
  async handleReportSweep() {
    if (this.isStillRunning(this.reportSweepStartedAt, 'handleReportSweep')) {
      this.logger.log('[BATCH] 이전 handleReportSweep 진행 중 — skip');
      return;
    }
    this.reportSweepStartedAt = Date.now();
    try {
      await this.deliveryBatchService.reportSweep();
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.reportSweepStartedAt = null;
    }
  }

  // 5분마다 실행. issueAndSend와 동시 trigger 회피를 위해 30초 offset.
  @Cron('30 */5 * * * *')
  async handleDeliveryStatusUpdate() {
    if (this.isStillRunning(this.statusUpdateStartedAt, 'handleDeliveryStatusUpdate')) {
      this.logger.log('[BATCH] 이전 handleDeliveryStatusUpdate 진행 중 — skip');
      return;
    }
    this.statusUpdateStartedAt = Date.now();
    try {
      await this.deliveryBatchService.updateDeliveryStatusFromTracking();
      this.logger.log('Completed delivery status update');
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.statusUpdateStartedAt = null;
    }
  }

  // 개인정보 파기
  // 매일 00시 실행
  @Cron('0 0 * * *')
  async handleDeliveryTargetDestroy() {
    try {
      await this.deliveryBatchService.deliveryDeliveryTargetDestroy();
      this.logger.log('delivery Target update');
    } catch (e) {
      this.logger.error(e);
    }
  }

  // 쿠폰 이미지 정리
  // 매일 03시 실행 - 유효기간 만료된 쿠폰 이미지 파일 삭제
  @Cron('0 0 3 * * *')
  async handleCouponImageCleanup() {
    try {
      await this.deliveryBatchService.cleanupExpiredCouponImages();
    } catch (e) {
      this.logger.error(e);
    }
  }

  // 독려문자 발송
  // 매일 15시 실행
  @Cron('0 15 * * *')
  async handleDeliveryEncourage() {
    if (this.isStillRunning(this.encourageStartedAt, 'handleDeliveryEncourage')) {
      this.logger.log('[BATCH] 이전 handleDeliveryEncourage 진행 중 — skip');
      return;
    }
    this.encourageStartedAt = Date.now();
    try {
      await this.deliveryBatchService.handleDeliveryEncourage();
      this.logger.log('encourage msg send');
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.encourageStartedAt = null;
    }
  }

  // Gemtek 결과 조회 — 접수 후 30분 간격(§7 표 4). 확정월 파티션을 증분 범위만 훑는다(§7.3).
  // 다른 cron 과 동시 trigger 회피를 위해 20초 offset.
  @Cron('20 */30 * * * *')
  async handleMessageResultReconcile() {
    if (this.isStillRunning(this.resultReconcileStartedAt, 'handleMessageResultReconcile')) {
      this.logger.log('[BATCH] 이전 handleMessageResultReconcile 진행 중 — skip');
      return;
    }
    this.resultReconcileStartedAt = Date.now();
    try {
      const summary = await this.messageResultReconcileService.reconcileOnce();
      if (summary.scanned > 0) {
        this.logger.log(
          `[TRACKING] 결과 조회 scanned=${summary.scanned} success=${summary.succeeded} fail=${summary.failed} ` +
            `retry=${summary.retryScheduled} unknown=${summary.unknown} pending=${summary.pending} ` +
            `recovered=${summary.recovered}`,
        );
      }
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.resultReconcileStartedAt = null;
    }
  }

  // 상태별 최대 체류시간(표 4-1) 초과 건 강제 전이·운영 승격. 10분마다, 50초 offset.
  @Cron('50 */10 * * * *')
  async handleTrackingSlaSweep() {
    if (this.isStillRunning(this.trackingSlaStartedAt, 'handleTrackingSlaSweep')) {
      this.logger.log('[BATCH] 이전 handleTrackingSlaSweep 진행 중 — skip');
      return;
    }
    this.trackingSlaStartedAt = Date.now();
    try {
      const summary = await this.messageResultReconcileService.sweepSlaOnce();
      if (summary.toReconciling || summary.toUnknown || summary.expiredResend) {
        this.logger.warn(
          `[TRACKING_SLA] reconciling=${summary.toReconciling} unknown=${summary.toUnknown} ` +
            `escalated=${summary.escalated} expiredResend=${summary.expiredResend}`,
        );
      }
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.trackingSlaStartedAt = null;
    }
  }

  // 504 자동 재발송 실행(§6.3 dueResend, §10 4단계 canary — DELIVERY_AUTO_RESEND_504_ENABLED).
  // 자동 재발송 허용 창은 **08:00~20:00 KST**(§7.2) — 심야 확정분이 익일 08:00 으로 예약되므로
  // cron 도 08시부터 돈다(09시 시작이면 08시 도래 예약이 최대 1시간 지연된다). 최초 발송 배치의
  // 09~20시 제한과 다른 값인 것이 맞다. 다른 5분 cron(0/15/30/45초)과 동시 trigger 회피 25초 offset.
  @Cron('25 */5 8-19 * * *', { timeZone: 'Asia/Seoul' })
  async handleDueResend() {
    if (this.isStillRunning(this.dueResendStartedAt, 'handleDueResend')) {
      this.logger.log('[BATCH] 이전 handleDueResend 진행 중 — skip');
      return;
    }
    this.dueResendStartedAt = Date.now();
    try {
      const summary = await this.messageResendExecutorService.runDueResendOnce();
      if (summary.scanned > 0) {
        this.logger.log(
          `[DUE_RESEND] scanned=${summary.scanned} resent=${summary.resent} resumed=${summary.resumed} ` +
            `expired=${summary.expired} superseded=${summary.superseded} skipped=${summary.skipped}`,
        );
      }
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.dueResendStartedAt = null;
    }
  }

  // SSG 행사 잔액 복구 및 PIN INSERT 판정 sweep. 같은 5분 cron에서 실행해
  // 독립 cron 경쟁 없이 각각의 DB CAS/lease fencing으로 수렴시킨다.
  // 5분마다 실행. 다른 5분 cron 과 동시 trigger 회피를 위해 15초 offset.
  @Cron('15 */5 * * * *')
  async handleSsgRecoverySweep() {
    if (this.isStillRunning(this.ssgRecoverySweepStartedAt, 'handleSsgRecoverySweep')) {
      this.logger.log('[BATCH] 이전 handleSsgRecoverySweep 진행 중 — skip');
      return;
    }
    this.ssgRecoverySweepStartedAt = Date.now();
    try {
      await this.ssgRecoverySweepService.sweepOnce();
      await this.ssgRecoverySweepService.resolvePinIssuesOnce();
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.ssgRecoverySweepStartedAt = null;
    }
  }

  // SSG 재발급 선차감 durable pending 복구 sweep. crash 로 누락된 선차감 역복원/유지를 자동 수렴.
  // plans/wip4-ssg-resend-deduct-durable.md. 5분마다, 다른 5분 cron 과 동시 trigger 회피를 위해 45초 offset.
  @Cron('45 */5 * * * *')
  async handleResendDeductSweep() {
    if (this.isStillRunning(this.resendDeductSweepStartedAt, 'handleResendDeductSweep')) {
      this.logger.log('[BATCH] 이전 handleResendDeductSweep 진행 중 — skip');
      return;
    }
    this.resendDeductSweepStartedAt = Date.now();
    try {
      await this.ssgResendDeductRecoveryService.sweepOnce();
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.resendDeductSweepStartedAt = null;
    }
  }
}
