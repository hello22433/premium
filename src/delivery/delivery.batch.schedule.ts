// 요청시각에 따른 전송 배치

import { DeliveryBatchService } from './application/delivery.batch.service';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class DeliveryBatchSchedule implements OnApplicationBootstrap {
  constructor(private deliveryBatchService: DeliveryBatchService) {}

  onApplicationBootstrap() {
    // this.deliveryBatchService.deliveryDeliveryTargetDestroy();
    // TEST;
    // this.deliveryBatchService.issueAndSend();
    // this.handleStatusUpdateBatch();
  }

  private logger = new Logger('BATCH');

  // 동시 실행 방지 플래그 (타임스탬프)
  private issueAndSendStartedAt: Date | null = null;
  private readonly MAX_BATCH_DURATION = 30 * 60 * 1000; // 30분

  // 5분 마다 실행
  @Cron('0 */5 * * * *')
  async issueAndSend() {
    const now = new Date();
    if (this.issueAndSendStartedAt) {
      const elapsed = now.getTime() - this.issueAndSendStartedAt.getTime();

      if (elapsed > this.MAX_BATCH_DURATION) {
        this.logger.warn(
          `[BATCH] issueAndSend가 ${Math.floor(elapsed / 60000)}분 동안 실행 중. 강제 리셋합니다.`,
        );
        this.issueAndSendStartedAt = null;
      } else {
        this.logger.warn('[BATCH] issueAndSend 이전 배치가 실행 중입니다. 스킵합니다.');
        return;
      }
    }

    this.issueAndSendStartedAt = now;
    try {
      await this.deliveryBatchService.issueAndSend();
      this.logger.log('Complete Delivery');
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.issueAndSendStartedAt = null;
    }
  }

  // 5분마다 실행
  @Cron('0 */5 * * * *')
  async handleDeliveryStatusUpdate() {
    try {
      await this.deliveryBatchService.updateDeliveryStatusFromTracking();
      this.logger.log('Completed delivery status update');
    } catch (e) {
      this.logger.error(e);
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
    try {
      await this.deliveryBatchService.handleDeliveryEncourage();
      this.logger.log('encourage msg send');
    } catch (e) {
      this.logger.error(e);
    }
  }
}
