import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ActivityLogService } from './activity.log.service';

/**
 * activity_log 보존기간 초과 로그 purge cron. 매일 04:00 1회.
 * 보존기간/제외 actionType 은 activity.log.retention 상수에 고정.
 */
@Injectable()
export class ActivityLogPurgeSchedule {
  private readonly logger = new Logger('ACTIVITY_LOG_PURGE');
  private running = false;

  constructor(private readonly activityLogService: ActivityLogService) {}

  @Cron('0 0 4 * * *')
  async handlePurge() {
    if (this.running) {
      this.logger.log('이전 purge 진행 중 — skip');
      return;
    }
    this.running = true;
    try {
      const deleted = await this.activityLogService.purgeOldLogs();
      this.logger.log(`보존기간 초과 로그 ${deleted}건 삭제`);
    } catch (e) {
      this.logger.error('로그 purge 실패', e as Error);
    } finally {
      this.running = false;
    }
  }
}
