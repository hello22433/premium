// 요청시각에 따른 전송 배치

import { DeliveryBatchService } from './application/delivery.batch.service';
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
  constructor(private deliveryBatchService: DeliveryBatchService) {}

  // 부팅 stale claim 해제는 main.ts(listen() 전)에서만 수행한다. lifecycle 훅은 migration
  // 스크립트 등 standalone bootstrap 에서도 발화해 살아있는 claim 을 해제할 위험이 있다.

  private logger = new Logger('BATCH');

  // cron 중복 실행 차단 플래그. 이전 batch가 진행 중이면 다음 cron은 즉시 return하여
  // claim 쿼리와 진행 중 save 쿼리 사이 데드락을 차단한다.
  private issueAndSendStartedAt: number | null = null;
  private statusUpdateStartedAt: number | null = null;
  private encourageStartedAt: number | null = null;

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

  // 5분 마다 실행. cron 중복 실행 차단으로 진행 중에는 후속 cron skip.
  @Cron('0 */5 * * * *')
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
}
