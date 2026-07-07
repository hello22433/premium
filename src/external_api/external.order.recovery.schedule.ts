import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ExternalOrderRecoveryService } from './application/external.order.recovery.service';

/**
 * 외부주문 완료전이 drift 복구 스윕 스케줄.
 * Phase B(발송) 성공 후 Phase C(완료 전이) 전 크래시로 DELIVERY_REQUEST 에 stuck 된
 * 외부/SSG 주문을 발송 성공 이력 기준으로 자동 수렴시킨다.
 */
@Injectable()
export class ExternalOrderRecoverySchedule {
  private readonly logger = new Logger('EXT_RECOVERY');
  private running = false;

  constructor(private readonly recoveryService: ExternalOrderRecoveryService) {}

  // 5분마다. 다른 5분 cron(0/15/30/45초 offset)과 동시 trigger 회피를 위해 50초 offset.
  @Cron('50 */5 * * * *')
  async handleRecovery(): Promise<void> {
    if (this.running) {
      this.logger.log('[EXT_RECOVERY] 이전 복구 sweep 진행 중 — skip');
      return;
    }
    this.running = true;
    try {
      await this.recoveryService.recoverStuckOrders();
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.running = false;
    }
  }
}
