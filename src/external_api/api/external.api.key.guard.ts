import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';

import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { ApiCredentialEntity } from '../../entity/api.credential.entity';
import { ExternalApiException } from './external.api.exception.filter';
import { IUserStatus } from '../../user/interface/user.status';
import { AccountStatusTransitionService } from '../../account_lifecycle/application/account.status.transition.service';
import { ApiRequestContext } from './api-request-context';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @InjectRepository(ExternalApiAccountEntity)
    private accountRepository: Repository<ExternalApiAccountEntity>,
    @InjectRepository(ApiCredentialEntity)
    private credentialRepository: Repository<ApiCredentialEntity>,
    private readonly accountStatusTransitionService: AccountStatusTransitionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'] as string;
    if (!apiKey) {
      throw new ExternalApiException('1001', '인증 실패');
    }

    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    // SoT: credential→app. 신규 인증 게이트. 단순모드에선 credential.api_key_hash가
    // account.api_key_hash와 1:1이라 동일 hash로 양쪽 모두 조회된다. (BaseEntity soft-delete 자동 제외)
    const credential = await this.credentialRepository.findOne({
      where: { apiKeyHash: keyHash, isActive: true },
      relations: ['apiApp', 'apiApp.allowedIps'],
    });
    if (!credential || !credential.apiApp || !credential.apiApp.isActive) {
      throw new ExternalApiException('1001', '인증 실패');
    }

    // 전환기: 레거시 account 로딩 — service billing/product/settlement/webhook 로직이
    // account.user/account.resendMaxCount/account.cancelWebhook* 등을 읽는다.
    // HIGH-4(다중키/회전): account 를 apiKeyHash 가 아닌 apiApp.sourceAccountId(결정적 매핑)로 로드한다.
    //   → 신규 credential 단독 발급(새 hash) 시에도 account 조회가 깨지지 않음(account 는 구 hash 보유).
    //   sourceAccountId 미설정(순수 PR2 app)은 defaultBillingUserId 로 폴백.
    const account =
      credential.apiApp.sourceAccountId != null
        ? await this.accountRepository.findOne({
            where: { id: credential.apiApp.sourceAccountId, isActive: true },
            relations: ['user', 'user.company', 'allowedIps'],
          })
        : await this.accountRepository.findOne({
            where: { userId: credential.apiApp.defaultBillingUserId, isActive: true },
            relations: ['user', 'user.company', 'allowedIps'],
          });

    if (!account) {
      throw new ExternalApiException('1001', '인증 실패');
    }

    // 휴면(NOT_USED)/탈퇴(LEAVE) 계정은 API 인증도 차단 (자동전환 실효 보장)
    // account.user = app.default_billing_user_id 상응 (단순모드 동일)
    const userStatus = account.user?.status;
    if (userStatus === IUserStatus.NOT_USED || userStatus === IUserStatus.LEAVE) {
      throw new ExternalApiException('1001', '비활성 계정입니다.');
    }

    const callerIp = this.resolveCallerIp(request);
    // IP 검사는 app 기준. M3 백필 + 관리 API의 apiAppId 적재로 app.allowedIps 완전.
    const allowedIps = credential.apiApp.allowedIps ?? [];
    const allowed = allowedIps.some((ip) => ip.ipAddress === callerIp);
    if (!allowed) {
      throw new ExternalApiException('1004', '허용되지 않은 IP', callerIp);
    }
    // 전환기 불변식(fail-closed): credential→app 의 default_billing_user_id 와
    // 레거시 account.user.id 가 어긋나면(M2 데이터 이상) 인증 거절. silent divergence 차단.
    if (account.user?.id !== credential.apiApp.defaultBillingUserId) {
      throw new ExternalApiException('1001', '인증 실패');
    }
    // 전환기 alias 유지: service 로직이 req.apiAccount를 계속 사용.
    request.apiAccount = account;

    // 신규 SoT 컨텍스트 병행 추가. billingUserId = app.default_billing_user_id.
    const apiContext: ApiRequestContext = {
      apiApp: credential.apiApp,
      apiCredential: credential,
      billingUserId: credential.apiApp.defaultBillingUserId,
      externalCustomerId: null,
    };
    request.apiContext = apiContext;

    // 활동 시각 갱신 (휴면 판정 기준 = 로그인 OR API. throttle 1일). 인증 성공 후 best-effort.
    // touchLastActivity 기준 = account.user.id = default_billing_user_id.
    if (account.user) {
      await this.accountStatusTransitionService.touchLastActivity(account.user.id, account.user.lastActivityAt);
    }

    return true;
  }

  private resolveCallerIp(request: any): string {
    const forwarded = request.headers['x-forwarded-for'] as string | undefined;
    const raw = forwarded ? forwarded.split(',')[0].trim() : request.ip || request.connection?.remoteAddress || '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  }
}
