import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DepositSyncService } from './deposit.sync.service';

/**
 * 입금내역 미러 동기화 스케줄.
 *
 * 기본은 꺼져 있다(DEPOSIT_SYNC_ENABLED=false). erp_macro 조회 API 와 회선이 준비되기 전에
 * 켜지면 5분마다 실패 로그만 쌓이므로, 준비가 끝난 환경에서만 켠다.
 *
 * 분(分)의 45초 지점을 쓰는 이유: 이 레포의 다른 5분 배치들이 :00/:25/:30/:58 에 몰려 있어
 * 겹치지 않게 비운 자리다.
 */
@Injectable()
export class DepositSyncSchedule {
  private logger = new Logger('DEPOSIT_SYNC');

  constructor(private depositSyncService: DepositSyncService) {}

  @Cron('45 */5 * * * *', { timeZone: 'Asia/Seoul' })
  async syncDeposits(): Promise<void> {
    if (!this.depositSyncService.isEnabled()) {
      return;
    }

    try {
      await this.depositSyncService.syncRecent();
    } catch (error) {
      // 영구 실패(인증·설정·계약 불일치)는 다음 주기에도 똑같이 실패한다. 사람이 봐야 한다.
      // 일시 실패는 다음 주기가 같은 구간을 다시 요청하므로 경고로 충분하다.
      if (DepositSyncService.isPermanent(error)) {
        this.logger.error(`동기화 영구 실패 — 설정/계약 확인 필요: ${(error as Error).message}`);
      } else {
        this.logger.warn(`동기화 일시 실패 — 다음 주기에 재시도합니다: ${(error as Error).message}`);
      }
    }
  }
}
