import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * API Key 기준으로 Rate Limit 적용.
 * 기본 ThrottlerGuard는 IP 기반이지만, 외부 API는 API Key(= user.id) 기준이 적절.
 */
@Injectable()
export class ExternalApiThrottleGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // ApiKeyGuard가 먼저 실행되어 apiUser를 설정함
    return req.apiUser?.id?.toString() ?? req.ip;
  }
}
