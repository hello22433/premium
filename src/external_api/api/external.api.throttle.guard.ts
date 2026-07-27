import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'node:crypto';

@Injectable()
export class ExternalApiThrottleGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.apiContext?.apiApp?.id?.toString() ?? req.apiAccount?.id?.toString() ?? req.ip;
  }

  protected generateKey(_context: ExecutionContext, tracker: string, name: string): string {
    return createHash('sha256').update(`external-api-${name}-${tracker}`).digest('hex');
  }
}
