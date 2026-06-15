import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';

import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { ExternalApiException } from './external.api.exception.filter';
import { IUserStatus } from '../../user/interface/user.status';
import { AccountStatusTransitionService } from '../../account_lifecycle/application/account.status.transition.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @InjectRepository(ExternalApiAccountEntity)
    private accountRepository: Repository<ExternalApiAccountEntity>,
    private readonly accountStatusTransitionService: AccountStatusTransitionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'] as string;
    if (!apiKey) {
      throw new ExternalApiException('1001', '인증 실패');
    }

    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const account = await this.accountRepository.findOne({
      where: { apiKeyHash: keyHash, isActive: true },
      relations: ['user', 'user.company', 'allowedIps'],
    });

    if (!account) {
      throw new ExternalApiException('1001', '인증 실패');
    }

    // 휴면(NOT_USED)/탈퇴(LEAVE) 계정은 API 인증도 차단 (자동전환 실효 보장)
    const userStatus = account.user?.status;
    if (userStatus === IUserStatus.NOT_USED || userStatus === IUserStatus.LEAVE) {
      throw new ExternalApiException('1001', '비활성 계정입니다.');
    }

    const callerIp = this.resolveCallerIp(request);
    const allowed = (account.allowedIps ?? []).some((ip) => ip.ipAddress === callerIp);
    if (!allowed) {
      throw new ExternalApiException('1004', '허용되지 않은 IP', callerIp);
    }

    request.apiAccount = account;

    // 활동 시각 갱신 (휴면 판정 기준 = 로그인 OR API. throttle 1일). 인증 성공 후 best-effort.
    if (account.user) {
      await this.accountStatusTransitionService.touchLastActivity(account.user.id, account.user.lastActivityAt);
    }

    return true;
  }

  private resolveCallerIp(request: any): string {
    const forwarded = request.headers['x-forwarded-for'] as string | undefined;
    const raw = forwarded
      ? forwarded.split(',')[0].trim()
      : request.ip || request.connection?.remoteAddress || '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  }
}
