import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CreditExcessApprovalDispatchService } from './application/credit-excess-approval-dispatch.service';

/**
 * PROCESSING lease 만료 복구.
 *
 * lease 만료만으로 실패 처리하지 않는다. approval row 를 잠근 뒤 실행 표식을 다시 확인해
 * 커밋된 발송확정은 COMPLETED 로 수렴시키고, 표식이 없을 때만 FAILED 로 전이한다.
 */
@Injectable()
export class CreditExcessApprovalRecoverySchedule {
  private readonly logger = new Logger(CreditExcessApprovalRecoverySchedule.name);
  private running = false;

  constructor(private readonly dispatchService: CreditExcessApprovalDispatchService) {}

  @Cron('20 */2 * * * *')
  async handleRecovery(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const recovered = await this.dispatchService.recoverExpiredLeases();
      if (recovered > 0) {
        this.logger.warn(`[CREDIT_EXCESS] lease 복구 ${recovered}건`);
      }
    } catch (error) {
      this.logger.error('[CREDIT_EXCESS] lease 복구 실패', error);
    } finally {
      this.running = false;
    }
  }
}
