import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { subMonths } from 'date-fns';
import { UserEntity } from '../../entity/user.entity';
import { IUserStatus } from '../../user/interface/user.status';
import { IMailSend } from '../../mail/interface/mail-send';
import { AccountStatusTransitionService } from './account.status.transition.service';
import { TransitionSource } from '../interface/transition.source';
import {
  dormantSuspendTemplate,
  dormantWithdrawTemplate,
  dormantDeleteTemplate,
} from '../domain/dormant.mail.template';

/**
 * 휴면/탈퇴 자동전환 배치.
 *
 * 타임라인: 3개월 미활동 → 중지(NOT_USED) → +6개월 → 탈퇴(LEAVE) → +6개월 → 익명화.
 *  - 미활동 판정 = last_activity_at (로그인 OR 외부 API 통합. last_login 아님).
 *  - 모든 전이는 AccountStatusTransitionService 의 조건부 UPDATE → 멱등.
 *  - 통보메일은 전이가 실제 발생(once-only)한 행에만 발송 → 중복 발송 없음.
 *  - 행별 try/catch: 1건 실패가 배치 전체를 중단하지 않음 (다음 실행에서 자연 재처리).
 */
@Injectable()
export class DormantBatchService {
  private readonly logger = new Logger('DORMANT_BATCH');

  /** 단계별 경과 기준(개월). 흔들림 방지 위해 한 곳 고정. */
  private static readonly SUSPEND_AFTER_MONTHS = 3; // 미활동 → 중지
  private static readonly WITHDRAW_AFTER_MONTHS = 6; // 중지 → 탈퇴
  private static readonly ANONYMIZE_AFTER_MONTHS = 6; // 탈퇴 → 익명화

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @Inject('IMailSend')
    private readonly mailSendService: IMailSend,
    private readonly transitionService: AccountStatusTransitionService,
  ) {}

  async run(): Promise<void> {
    const now = new Date();
    await this.suspendInactive(now);
    await this.withdrawSuspended(now);
    await this.anonymizeWithdrawn(now);
  }

  /** 1단계: USED + last_activity_at < now-3개월 → NOT_USED + 휴면 안내메일. */
  private async suspendInactive(now: Date): Promise<void> {
    const cutoff = subMonths(now, DormantBatchService.SUSPEND_AFTER_MONTHS);
    const targets = await this.userRepository.find({
      where: { status: IUserStatus.USED, lastActivityAt: LessThan(cutoff) },
      select: ['id', 'email', 'personName'],
    });
    let done = 0;
    for (const u of targets) {
      try {
        const ok = await this.transitionService.transitionToSuspended(u.id, { activityBefore: cutoff });
        if (!ok) continue;
        await this.sendMail(u.email, dormantSuspendTemplate(u.personName));
        done++;
      } catch (e) {
        this.logger.error(`[suspend] userId=${u.id} 실패`, e as Error);
      }
    }
    this.logger.log(`[suspend] 대상 ${targets.length}건 중 ${done}건 휴면 전환`);
  }

  /** 2단계: NOT_USED + suspended_at < now-6개월 → LEAVE + 탈퇴/파기예정 안내메일. */
  private async withdrawSuspended(now: Date): Promise<void> {
    const cutoff = subMonths(now, DormantBatchService.WITHDRAW_AFTER_MONTHS);
    const targets = await this.userRepository.find({
      where: { status: IUserStatus.NOT_USED, suspendedAt: LessThan(cutoff) },
      select: ['id', 'email', 'personName'],
    });
    let done = 0;
    for (const u of targets) {
      try {
        const ok = await this.transitionService.transitionToLeave(u.id, TransitionSource.DORMANT_BATCH, {
          fromStatus: IUserStatus.NOT_USED,
          suspendedBefore: cutoff,
        });
        if (!ok) continue;
        await this.sendMail(u.email, dormantWithdrawTemplate(u.personName));
        done++;
      } catch (e) {
        this.logger.error(`[withdraw] userId=${u.id} 실패`, e as Error);
      }
    }
    this.logger.log(`[withdraw] 대상 ${targets.length}건 중 ${done}건 탈퇴 전환`);
  }

  /**
   * 3단계: LEAVE + withdrawn_at < now-6개월 + 미익명화 → 파기 안내메일 후 익명화.
   * 익명화 시 email 이 마스킹되므로 메일을 먼저 보내고 익명화한다 (PM2 단일 인스턴스 전제).
   */
  private async anonymizeWithdrawn(now: Date): Promise<void> {
    const cutoff = subMonths(now, DormantBatchService.ANONYMIZE_AFTER_MONTHS);
    const targets = await this.userRepository.find({
      where: { status: IUserStatus.LEAVE, withdrawnAt: LessThan(cutoff), anonymizedAt: IsNull() },
      select: ['id', 'email', 'personName'],
    });
    let done = 0;
    for (const u of targets) {
      try {
        // 파기 직전 최종 고지 (익명화 후엔 email 소실 → 먼저 발송)
        await this.sendMail(u.email, dormantDeleteTemplate(u.personName));
        const ok = await this.transitionService.anonymizeAfterGracePeriod(u.id, { withdrawnBefore: cutoff });
        if (ok) done++;
      } catch (e) {
        this.logger.error(`[anonymize] userId=${u.id} 실패`, e as Error);
      }
    }
    this.logger.log(`[anonymize] 대상 ${targets.length}건 중 ${done}건 익명화`);
  }

  /** 통보메일 발송. 발송 실패는 warn 후 진행 (전이 자체는 이미 커밋됨). */
  private async sendMail(to: string, tpl: { title: string; content: string }): Promise<void> {
    try {
      await this.mailSendService.send({
        saveSentMail: 'N',
        bcc: undefined,
        cc: undefined,
        content: tpl.content,
        subject: tpl.title,
        to,
      });
    } catch (e) {
      this.logger.warn(`통보메일 발송 실패 to=${to}: ${(e as Error).message}`);
    }
  }
}
