import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../entity/user.entity';
import { ActivityLogModule } from '../activity_log/activity.log.module';
import { MailModule } from '../mail/mail.module';
import { AccountStatusTransitionService } from './application/account.status.transition.service';
import { DormantBatchService } from './application/dormant.batch.service';
import { DormantBatchSchedule } from './application/dormant.batch.schedule';

/**
 * 계정 라이프사이클 모듈.
 * - AccountStatusTransitionService: 상태 전이 공통 헬퍼 (export → User/UserManagement/외부API 공용)
 * - DormantBatchService/Schedule: 휴면→탈퇴→익명화 자동전환 cron + 단계별 통보메일
 * - 보존 purge cron 은 ActivityLogModule provider 로 등록 (ActivityLogPurgeSchedule).
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserEntity]), ActivityLogModule, MailModule],
  providers: [AccountStatusTransitionService, DormantBatchService, DormantBatchSchedule],
  exports: [AccountStatusTransitionService],
})
export class AccountLifecycleModule {}
