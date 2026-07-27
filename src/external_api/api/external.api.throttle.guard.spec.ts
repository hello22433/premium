import { createHash } from 'node:crypto';
import { ExecutionContext } from '@nestjs/common';
import { ExternalApiController } from './external.api.controller';
import { ExternalApiThrottleGuard } from './external.api.throttle.guard';

class TestExternalApiThrottleGuard extends ExternalApiThrottleGuard {
  constructor() {
    super({} as any, {} as any, {} as any);
  }

  getKey(context: ExecutionContext, tracker: string, bucket: string): string {
    return this.generateKey(context, tracker, bucket);
  }

  getTrackerForRequest(req: Record<string, any>): Promise<string> {
    return this.getTracker(req);
  }
}

describe('ExternalApiThrottleGuard', () => {
  const guard = new TestExternalApiThrottleGuard();

  it('generates the same key across execution contexts for the same bucket and tracker', () => {
    expect(guard.getKey({} as ExecutionContext, 'app-1', 'reads')).toBe(
      guard.getKey({} as ExecutionContext, 'app-1', 'reads'),
    );
  });
  it('matches the lowercase SHA-256 digest for the external API key namespace', () => {
    expect(guard.getKey({} as ExecutionContext, 'app-1', 'reads')).toBe(
      createHash('sha256').update('external-api-reads-app-1').digest('hex'),
    );
  });

  it('keeps exactly the intended throttle bucket active for every controller handler', () => {
    const expectedSkips: Record<string, readonly string[]> = {
      getProducts: ['orders', 'cancelResend'],
      createOrder: ['reads', 'cancelResend'],
      resendOrder: ['reads', 'orders'],
      getOrderStatusByExternalOrderId: ['orders', 'cancelResend'],
      getOrderStatus: ['orders', 'cancelResend'],
      cancelOrder: ['reads', 'orders'],
      createSsgOrder: ['reads', 'cancelResend'],
      getSsgOrderStatus: ['orders', 'cancelResend'],
    };
    const buckets = ['orders', 'reads', 'cancelResend'] as const;

    for (const [methodName, skippedBuckets] of Object.entries(expectedSkips)) {
      const handler = ExternalApiController.prototype[methodName as keyof ExternalApiController];
      const metadata = Object.fromEntries(
        buckets.map((bucket) => [
          bucket,
          Reflect.getMetadata(`THROTTLER:SKIP${bucket}`, handler),
        ]),
      );

      expect(Object.entries(metadata).filter(([, skipped]) => skipped)).toEqual(
        buckets.filter((bucket) => skippedBuckets.includes(bucket)).map((bucket) => [bucket, true]),
      );
      expect(skippedBuckets).toHaveLength(2);
      expect(buckets.filter((bucket) => !skippedBuckets.includes(bucket))).toHaveLength(1);
    }
  });

  it('generates different keys when the bucket or tracker changes', () => {
    const key = guard.getKey({} as ExecutionContext, 'app-1', 'reads');

    expect(guard.getKey({} as ExecutionContext, 'app-1', 'orders')).not.toBe(key);
    expect(guard.getKey({} as ExecutionContext, 'app-2', 'reads')).not.toBe(key);
  });

  it('uses apiApp.id before the legacy account id and IP', async () => {
    await expect(
      guard.getTrackerForRequest({
        apiContext: { apiApp: { id: 101 } },
        apiAccount: { id: 202 },
        ip: '192.0.2.1',
      }),
    ).resolves.toBe('101');
  });

  it('falls back to the legacy account id when apiApp.id is absent', async () => {
    await expect(
      guard.getTrackerForRequest({
        apiContext: { apiApp: {} },
        apiAccount: { id: 202 },
        ip: '192.0.2.1',
      }),
    ).resolves.toBe('202');
  });

  it('falls back to the request IP when app and legacy account ids are absent', async () => {
    await expect(
      guard.getTrackerForRequest({
        apiContext: { apiApp: {} },
        apiAccount: {},
        ip: '192.0.2.1',
      }),
    ).resolves.toBe('192.0.2.1');
  });
});
