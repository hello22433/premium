import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * API Key(=external_api_account) 단위로 Rate Limit 적용.
 * ApiKeyGuard가 먼저 실행되어 req.apiAccount를 설정한다.
 */
@Injectable()
export class ExternalApiThrottleGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.apiAccount?.id?.toString() ?? req.ip;
  }
}
