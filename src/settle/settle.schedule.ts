import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SettleService } from './application/settle.service';

@Injectable()
export class SettleSchedule implements OnApplicationBootstrap {
  constructor(private settleService: SettleService) {}

  onApplicationBootstrap() {
    // this.settleService.syncSettleOverdue();
  }

  private logger = new Logger('BATCH');

  // 매일 00시 30분 실행 (delivery 배치와 충돌 방지)
  @Cron('0 30 0 * * *')
  async handleDeliveryTargetDestroy() {
    try {
      await this.settleService.syncSettleOverdue();
      this.logger.log('sync settle overdue');
    } catch (e) {
      this.logger.error(e);
    }
  }
}
