// 요청시각에 따른 전송 배치

import { DeliveryBatchService } from './application/delivery.batch.service';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class DeliveryBatchSchedule implements OnApplicationBootstrap {
  constructor(private deliveryBatchService: DeliveryBatchService) {}

  onApplicationBootstrap() {
    // TEST;
    // this.deliveryBatchService.issueAndSend();
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
}
