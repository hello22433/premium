import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DormantBatchService } from './dormant.batch.service';

/**
 * 휴면/탈퇴 자동전환 cron. 매일 02:00 1회.
 * delivery.batch.schedule 패턴 차용 — max runtime dead-man's switch + 중복 실행 skip.
 */
const MAX_BATCH_RUNTIME_MS = 30 * 60 * 1000;

@Injectable()
export class DormantBatchSchedule {
  private readonly logger = new Logger('DORMANT_BATCH');
  private startedAt: number | null = null;

  constructor(private readonly dormantBatchService: DormantBatchService) {}

  private isStillRunning(): boolean {
    if (this.startedAt === null) return false;
    const elapsed = Date.now() - this.startedAt;
    if (elapsed > MAX_BATCH_RUNTIME_MS) {
      this.logger.warn(`max runtime(${MAX_BATCH_RUNTIME_MS / 1000}s) 초과 — stale 플래그 해제 후 진입`);
      return false;
    }
    return true;
  }

  @Cron('0 0 2 * * *')
  async handleDormantLifecycle() {
    if (this.isStillRunning()) {
      this.logger.log('이전 휴면배치 진행 중 — skip');
      return;
    }
    this.startedAt = Date.now();
    try {
      await this.dormantBatchService.run();
      this.logger.log('휴면 라이프사이클 배치 완료');
    } catch (e) {
      this.logger.error('휴면 라이프사이클 배치 실패', e as Error);
    } finally {
      this.startedAt = null;
    }
  }
}
