// 요청시각에 따른 전송 배치

import { DeliveryBatchService } from './application/delivery.batch.service';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class DeliveryBatchSchedule implements OnApplicationBootstrap {
  constructor(private deliveryBatchService: DeliveryBatchService) {}

  async onApplicationBootstrap() {
    // 비정상 종료로 claimed_at이 남아있는 WAIT 행을 해제한다.
    // PM2 단일 인스턴스 전제: 부팅 시점에는 진행 중인 배치가 있을 수 없다.
    try {
      const released = await this.deliveryBatchService.releaseStaleClaims();
      if (released > 0) {
        this.logger.warn(
          `[BATCH] 부팅 시 stale 클레임 ${released}건 해제 (이전 프로세스 비정상 종료 흔적)`,
        );
      }
    } catch (e) {
      this.logger.error('[BATCH] stale 클레임 해제 실패', e);
    }
  }

  private logger = new Logger('BATCH');

  // 5분 마다 실행 (배치 간 병렬 실행 — claimed_at으로 행 단위 격리)
  @Cron('0 */5 * * * *')
  async issueAndSend() {
    try {
      await this.deliveryBatchService.issueAndSend();
      this.logger.log('Complete Delivery');
    } catch (e) {
      this.logger.error(e);
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
