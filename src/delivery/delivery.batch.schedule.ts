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

  // 5분 마다 실행
  @Cron('0 */5 * * * *')
  async issueAndSend() {
    try {
      await this.deliveryBatchService.issueAndSend();
      this.logger.log('Complete Delivery');
      return;
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
  @Cron('0 15 * * *')
  async handleDeliveryTargetDestroy() {
    try {
      await this.deliveryBatchService.deliveryDeliveryTargetDestroy();
      this.logger.log('delivery Target update');
    } catch (e) {
      this.logger.error(e);
    }
  }
}
