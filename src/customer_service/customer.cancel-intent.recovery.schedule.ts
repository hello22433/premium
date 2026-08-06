import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CustomerServiceService } from './application/customer.service.service';

@Injectable()
export class CustomerCancelIntentRecoverySchedule {
  private readonly logger = new Logger(CustomerCancelIntentRecoverySchedule.name);
  private running = false;

  constructor(private readonly customerServiceService: CustomerServiceService) {}

  @Cron('58 */5 * * * *')
  async handleRecovery(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.customerServiceService.reconcileOpenCancelIntents();
    } catch (error) {
      this.logger.error('[CANCEL_INTENT] CS sweep 실패', error);
    } finally {
      this.running = false;
    }
  }
}
