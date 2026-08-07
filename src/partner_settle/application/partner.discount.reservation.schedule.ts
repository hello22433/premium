import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PartnerDiscountReservationService } from './partner.discount.reservation.service';

/**
 * 정산조건 예약 발효 cron. 매 분 처리한다 — 예약 단위가 시각(예: 14:00)이므로 분 단위면 충분하다.
 *
 * 서비스가 feature flag off 면 즉시 빈 배열을 돌려주므로, 배포만으로는 아무 것도 발효되지 않는다.
 * 동시 실행이 겹쳐도 예약 row CAS 로 승자가 하나뿐이지만, 불필요한 잠금 경합을 줄이기 위해
 * 진행 중이면 건너뛴다.
 */
const MAX_RUNTIME_MS = 10 * 60 * 1000;

@Injectable()
export class PartnerDiscountReservationSchedule {
  private readonly logger = new Logger('PARTNER_DISCOUNT_RESERVATION');
  private startedAt: number | null = null;

  constructor(private readonly reservationService: PartnerDiscountReservationService) {}

  @Cron('20 * * * * *')
  async applyDueReservations() {
    if (this.isStillRunning()) {
      this.logger.log('이전 예약 발효 진행 중 — skip');
      return;
    }
    this.startedAt = Date.now();
    try {
      const outcomes = await this.reservationService.applyDueReservations();
      if (outcomes.length > 0) {
        this.logger.log(`정산조건 예약 발효 처리 ${outcomes.length}건`);
      }
    } catch (e) {
      this.logger.error('정산조건 예약 발효 실패', e as Error);
    } finally {
      this.startedAt = null;
    }
  }

  private isStillRunning(): boolean {
    if (this.startedAt === null) return false;
    const elapsed = Date.now() - this.startedAt;
    if (elapsed > MAX_RUNTIME_MS) {
      this.logger.warn(`max runtime(${MAX_RUNTIME_MS / 1000}s) 초과 — stale 플래그 해제 후 진입`);
      return false;
    }
    return true;
  }
}
