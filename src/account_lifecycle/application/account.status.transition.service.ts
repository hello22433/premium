import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { UserEntity } from '../../entity/user.entity';
import { IUserStatus } from '../../user/interface/user.status';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { TransitionSource } from '../interface/transition.source';

/**
 * 계정 상태 전이 공통 헬퍼.
 *
 * 상태 전이마다 side-column(suspended_at/withdrawn_at/anonymized_at/last_activity_at)
 * 과 activity_log 를 한 곳에서 책임진다. 수동탈퇴·휴면배치·관리자 경로가 모두 경유하여
 * 동일한 side-effect 를 보장한다 (spec §6.5 경로 일원화).
 *
 * 모든 전이는 조건부 UPDATE(현재 상태 + 경과 timestamp 동시 검사)로 멱등하다.
 * 배치 중복/재실행 시 같은 행을 두 번 전이시키지 않는다.
 */
@Injectable()
export class AccountStatusTransitionService {
  private readonly logger = new Logger(AccountStatusTransitionService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly activityLogService: ActivityLogService,
  ) {}

  /** last_activity_at 갱신 throttle: 하루 1회 (쓰기 증폭 방지, 휴면 granularity 는 월 단위). */
  private static readonly ACTIVITY_THROTTLE_MS = 24 * 60 * 60 * 1000;

  /**
   * 활동 시각 갱신 (로그인 / 외부 API 인증 성공 시). throttle 적용 — 마지막 갱신이 1일 이내면 skip.
   * @param current 호출부가 이미 로드한 last_activity_at (있으면 추가 조회 없이 throttle 판정)
   */
  async touchLastActivity(userId: number, current?: Date | null): Promise<void> {
    if (current) {
      const elapsed = Date.now() - new Date(current).getTime();
      if (elapsed >= 0 && elapsed < AccountStatusTransitionService.ACTIVITY_THROTTLE_MS) {
        return;
      }
    }
    await this.userRepository.update({ id: userId }, { lastActivityAt: () => 'NOW()' });
  }

  /** 계정 생성 로그 (회원가입 / 관리자 생성 공통). */
  async logAccountCreate(userId: number, email: string, source: TransitionSource): Promise<void> {
    await this.writeLifecycleLog(userId, email, ActivityLogActionType.ACCOUNT_CREATE, source);
  }

  /**
   * USED 복귀 (재활성화 / 관리자 USED 세팅).
   * last_activity_at 리셋(휴면 시계 초기화), suspended_at/withdrawn_at 해제.
   * @returns 실제 전이 발생 여부 (이미 USED면 false)
   */
  async transitionToUsed(userId: number): Promise<boolean> {
    const res = await this.userRepository.update(
      { id: userId, status: Not(IUserStatus.USED) },
      {
        status: IUserStatus.USED,
        lastActivityAt: () => 'NOW()',
        suspendedAt: null,
        withdrawnAt: null,
      },
    );
    return (res.affected ?? 0) > 0;
  }

  /**
   * 휴면(NOT_USED) 전환. USED → NOT_USED 만 허용.
   * @param opts.activityBefore 지정 시 last_activity_at < activityBefore 인 행만 (배치 race 방지)
   * @returns 전이 발생 여부
   */
  async transitionToSuspended(userId: number, opts?: { activityBefore?: Date }): Promise<boolean> {
    const res = await this.userRepository.update(
      {
        id: userId,
        status: IUserStatus.USED,
        ...(opts?.activityBefore ? { lastActivityAt: LessThan(opts.activityBefore) } : {}),
      },
      { status: IUserStatus.NOT_USED, suspendedAt: () => 'NOW()' },
    );
    return (res.affected ?? 0) > 0;
  }

  /**
   * 탈퇴(LEAVE) 전환 + ACCOUNT_WITHDRAW 로그. PII 는 건드리지 않음 (+6개월 뒤 익명화).
   * - 수동/관리자: opts 없이 호출 → LEAVE 가 아닌 모든 상태에서 전이.
   * - 배치 2단계: opts.fromStatus=NOT_USED + suspendedBefore 로 게이트.
   * @returns 전이 발생 여부 (이미 LEAVE거나 조건 불충족이면 false)
   */
  async transitionToLeave(
    userId: number,
    source: TransitionSource,
    opts?: { fromStatus?: IUserStatus; suspendedBefore?: Date; reason?: string },
  ): Promise<boolean> {
    const res = await this.userRepository.update(
      {
        id: userId,
        status: opts?.fromStatus ?? Not(IUserStatus.LEAVE),
        ...(opts?.suspendedBefore ? { suspendedAt: LessThan(opts.suspendedBefore) } : {}),
      },
      { status: IUserStatus.LEAVE, withdrawnAt: () => 'NOW()' },
    );
    if ((res.affected ?? 0) === 0) {
      return false;
    }
    const user = await this.userRepository.findOne({ where: { id: userId }, select: ['id', 'email'] });
    await this.writeLifecycleLog(
      userId,
      user?.email ?? '',
      ActivityLogActionType.ACCOUNT_WITHDRAW,
      source,
      opts?.reason,
    );
    return true;
  }

  /**
   * 익명화(PII 파기) + ACCOUNT_ANONYMIZE 로그. LEAVE 상태에서만.
   * anonymized_at IS NULL 게이트로 once-only (멱등). 행·FK·거래이력은 유지.
   * @param opts.withdrawnBefore 지정 시 withdrawn_at < withdrawnBefore 인 행만 (배치 3단계)
   * @returns 익명화 발생 여부
   */
  async anonymizeAfterGracePeriod(userId: number, opts?: { withdrawnBefore?: Date }): Promise<boolean> {
    const res = await this.userRepository.update(
      {
        id: userId,
        status: IUserStatus.LEAVE,
        anonymizedAt: IsNull(),
        ...(opts?.withdrawnBefore ? { withdrawnAt: LessThan(opts.withdrawnBefore) } : {}),
      },
      {
        email: `deleted_${userId}@anonymized.local`,
        personName: '탈퇴회원',
        personPhoneNumber: '',
        personEmail: '',
        personCode: `deleted_${userId}`,
        ip: null,
        password: '',
        anonymizedAt: () => 'NOW()',
      },
    );
    if ((res.affected ?? 0) === 0) {
      return false;
    }
    await this.writeLifecycleLog(
      userId,
      `deleted_${userId}@anonymized.local`,
      ActivityLogActionType.ACCOUNT_ANONYMIZE,
      TransitionSource.DORMANT_BATCH,
    );
    return true;
  }

  /**
   * 관리자 직접 상태 변경 일원화 (user-management update).
   * 현재 상태와 무관하게 target 으로 전이하되 side-column + 로그를 공통 헬퍼와 동일하게 보장한다.
   * (현재상태 === target 이면 호출부에서 skip — 불필요한 last_activity_at 리셋 방지)
   */
  async adminSetStatus(userId: number, target: IUserStatus): Promise<void> {
    switch (target) {
      case IUserStatus.USED:
        await this.transitionToUsed(userId);
        break;
      case IUserStatus.NOT_USED:
        await this.userRepository.update(
          { id: userId, status: Not(IUserStatus.NOT_USED) },
          { status: IUserStatus.NOT_USED, suspendedAt: () => 'NOW()' },
        );
        break;
      case IUserStatus.LEAVE:
        await this.transitionToLeave(userId, TransitionSource.ADMIN);
        break;
      default:
        // NOT_APPROVED 등 — side-column 무관, 상태만 변경
        await this.userRepository.update({ id: userId }, { status: target });
        break;
    }
  }

  /** 라이프사이클 로그 1건 기록. 배치는 HTTP 컨텍스트 없음 → method/url/ip 를 SYSTEM 값으로 채움. */
  private async writeLifecycleLog(
    userId: number,
    email: string,
    actionType: ActivityLogActionType,
    source: TransitionSource,
    reason?: string,
  ): Promise<void> {
    const isBatch = source === TransitionSource.DORMANT_BATCH;
    await this.activityLogService.createLog({
      userId,
      userEmail: email,
      method: isBatch ? 'BATCH' : 'POST',
      requestUrl: isBatch ? 'dormant-batch' : `account-lifecycle/${actionType}`,
      actionType,
      ipAddress: isBatch ? 'SYSTEM' : '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: { source, ...(reason ? { reason } : {}) },
    });
  }
}
