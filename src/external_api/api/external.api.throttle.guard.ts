import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * api_app 단위로 Rate Limit 적용 (PR2a). 전환기엔 apiAccount.id/IP 폴백.
 * ApiKeyGuard가 먼저 실행되어 req.apiContext(및 전환기 req.apiAccount)를 설정한다.
 */
@Injectable()
export class ExternalApiThrottleGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // apiAppId 고정 트래커, 전환기 폴백.
    return req.apiContext?.apiApp?.id?.toString() ?? req.apiAccount?.id?.toString() ?? req.ip;
  }
}
