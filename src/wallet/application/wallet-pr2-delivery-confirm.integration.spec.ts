import { BadRequestException } from '@nestjs/common';
import { OrderConfirmationReleaseService } from './order-confirmation-release.service';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import { OrderPointUsageEntity } from '../../entity/order.point.usage.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import {
  OrderDeliveryAttemptEntity,
  OrderDeliveryAttemptStatus,
  OrderDeliveryAttemptType,
} from '../../entity/order.delivery.attempt.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';
import { buildConfirmReleaseKey } from '../interface/wallet-idempotency';

// PR2-007 mini integration spec — wallet primitives + idempotency + throw rollback.
// Real MySQL e2e deferred (requires DB creds + live migrations).

describe('PR2-007 wallet-pr2-delivery-confirm integration', () => {
  function createManager(overrides: {
    allocation: Partial<OrderPaymentAllocationEntity>;
    wallet: Partial<WalletAccountEntity>;
    pointUsages: Partial<OrderPointUsageEntity>[];
    pointGrants: Partial<PointGrantEntity>[];
    lineDeliveries: number[];
    attempts: Partial<OrderDeliveryAttemptEntity>[];
    failPointUpdateForGrantId?: string;
  }) {
    const txs: WalletTransactionEntity[] = [];
    const savedAllocations: OrderPaymentAllocationEntity[] = [];
    const savedAttempts: OrderDeliveryAttemptEntity[] = [];
    const savedWallets: WalletAccountEntity[] = [];
    const savedPointUsages: OrderPointUsageEntity[] = [];
    const allocationRef = { ...overrides.allocation } as OrderPaymentAllocationEntity;
    const walletRef = { ...overrides.wallet } as WalletAccountEntity;
    const usagesRef = overrides.pointUsages.map((u) => ({ ...u } as OrderPointUsageEntity));
    const grantsRef = overrides.pointGrants.map((g) => ({ ...g } as PointGrantEntity));
    const attemptsRef = overrides.attempts.map((a) => ({ ...a } as OrderDeliveryAttemptEntity));

    const repoFor = (entity: any) => {
      if (entity === OrderPaymentAllocationEntity) {
        return {
          createQueryBuilder: () => ({
            setLock: () => ({ where: () => ({ getOne: async () => allocationRef }) }),
          }),
        };
      }
      if (entity === OrderPaymentAllocationLineEntity) {
        return {
          createQueryBuilder: () => ({
            select: () => ({
              where: () => ({
                andWhere: () => ({
                  getRawMany: async () =>
                    overrides.lineDeliveries.map((id) => ({ orderDeliveryId: id })),
                }),
              }),
            }),
          }),
        };
      }
      if (entity === WalletAccountEntity) {
        return {
          createQueryBuilder: () => ({
            setLock: () => ({ where: () => ({ getOne: async () => walletRef }) }),
          }),
        };
      }
      return {};
    };

    const runUpdate = async (params: any, patch: any) => {
      if (overrides.failPointUpdateForGrantId && params.id === overrides.failPointUpdateForGrantId) {
        return { affected: 0 };
      }
      const grant = grantsRef.find((g) => g.id === params.id);
      if (grant) {
        const raw = typeof patch.remainingAmount === 'function' ? patch.remainingAmount() : patch.remainingAmount;
        const m = /remaining_amount \+ (\d+)/.exec(String(raw));
        if (m) {
          grant.remainingAmount = (grant.remainingAmount ?? 0) + Number(m[1]);
        }
      }
      return { affected: 1 };
    };

    const manager: any = {
      getRepository: repoFor,
      findOne: async (entity: any, opts: any) => {
        if (entity === PointGrantEntity) {
          return grantsRef.find((g) => g.id === opts.where.id) ?? null;
        }
        if (entity === OrderPaymentAllocationEntity) {
          if (opts?.where?.orderId === undefined || opts.where.orderId === allocationRef.orderId) {
            return allocationRef;
          }
          return null;
        }
        return null;
      },
      find: async (entity: any) => {
        if (entity === OrderPointUsageEntity) return usagesRef;
        if (entity === OrderDeliveryAttemptEntity) return attemptsRef;
        return [];
      },
      save: async (entity: any, value: any) => {
        if (entity === WalletAccountEntity) {
          Object.assign(walletRef, value);
          savedWallets.push({ ...walletRef });
          return walletRef;
        }
        if (entity === WalletTransactionEntity) {
          const next = { id: `tx-${txs.length + 1}`, ...value } as WalletTransactionEntity;
          if (txs.some((t) => t.idempotencyKey === next.idempotencyKey)) {
            const err: any = new Error('duplicate idempotency_key');
            err.code = 'ER_DUP_ENTRY';
            throw err;
          }
          txs.push(next);
          return next;
        }
        if (entity === OrderPaymentAllocationEntity) {
          Object.assign(allocationRef, value);
          savedAllocations.push({ ...allocationRef });
          return allocationRef;
        }
        if (entity === OrderPointUsageEntity) {
          const exists = usagesRef.findIndex((u) => u.id === value.id);
          if (exists >= 0) usagesRef[exists] = value;
          else usagesRef.push(value);
          savedPointUsages.push(value);
          return value;
        }
        if (entity === OrderDeliveryAttemptEntity) {
          savedAttempts.push({ ...value });
          return value;
        }
        return value;
      },
      createQueryBuilder: () => ({
        update: () => ({
          set: (patch: any) => ({
            where: (_clause: string, params: any) => ({
              execute: async () => runUpdate(params, patch),
            }),
          }),
        }),
      }),
    };

    return {
      manager,
      state: { txs, savedAllocations, savedAttempts, savedWallets, walletRef, grantsRef, attemptsRef },
    };
  }

  const buildBaseFixture = () => ({
    allocation: {
      id: 'alloc-1',
      orderId: 777,
      walletAccountId: 'w-1',
      depositUsedAmount: 5000,
      depositRestoredAmount: 0,
      creditUsedAmount: 3000,
      creditUsedRestoredAmount: 0,
      creditExcessAmount: 1000,
      creditExcessRestoredAmount: 0,
      pointUsedAmount: 2000,
      pointRestoredAmount: 0,
      pointSkippedExpiredAmount: 0,
      releasedAt: null as Date | null,
      releaseReason: null as string | null,
    },
    wallet: { id: 'w-1', depositBalance: 1000, creditUsedAmount: 3000, creditExcessAmount: 1000 },
    pointUsages: [
      { id: 'pu-1', allocationId: 'alloc-1', pointGrantId: 'g-1', usedAmount: 2000, restoredAmount: 0, skippedExpiredAmount: 0 },
    ],
    pointGrants: [{ id: 'g-1', remainingAmount: 0, active: 1 }],
    lineDeliveries: [101, 102],
    attempts: [
      { id: 'att-1', orderDeliveryId: 101, attemptType: OrderDeliveryAttemptType.INITIAL, status: OrderDeliveryAttemptStatus.DEDUCTED },
      { id: 'att-2', orderDeliveryId: 102, attemptType: OrderDeliveryAttemptType.INITIAL, status: OrderDeliveryAttemptStatus.DEDUCTED },
    ],
  });

  function createService() {
    const svc = Object.create(OrderConfirmationReleaseService.prototype) as OrderConfirmationReleaseService;
    (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    (svc as any).dataSource = { transaction: async (cb: any) => cb({}) };
    return svc;
  }

  it('Case A: confirm_release happy path — wallet/point/attempt 동기 + allocation released', async () => {
    const fixture = buildBaseFixture();
    const { manager, state } = createManager(fixture);
    const svc = createService();

    const result = await svc.releaseConfirmation(
      { orderId: 777, reason: 'order_cancel', failedDeliveryIds: null },
      manager,
    );

    expect(result.alreadyReleased).toBe(false);
    expect(state.txs.map((t) => t.resourceType)).toEqual(
      expect.arrayContaining([
        WalletResourceType.DEPOSIT,
        WalletResourceType.CREDIT,
        WalletResourceType.CREDIT_EXCESS,
        WalletResourceType.POINT,
      ]),
    );
    const depositTx = state.txs.find((t) => t.resourceType === WalletResourceType.DEPOSIT)!;
    expect(depositTx.idempotencyKey).toBe(buildConfirmReleaseKey(777, null, WalletResourceType.DEPOSIT));
    expect(state.walletRef.depositBalance).toBe(1000 + 5000);
    expect(state.walletRef.creditUsedAmount).toBe(0);
    expect(state.walletRef.creditExcessAmount).toBe(0);
    expect(state.grantsRef[0].remainingAmount).toBe(2000);
    expect(state.attemptsRef.every((a) => a.status === OrderDeliveryAttemptStatus.ROLLED_BACK)).toBe(true);
    expect(state.savedAllocations.at(-1)!.releasedAt).toBeInstanceOf(Date);
    expect(state.savedAllocations.at(-1)!.releaseReason).toBe('order_cancel');
  });

  it('Case B: idempotent re-call — released_at set 된 allocation → no-op', async () => {
    const fixture = buildBaseFixture();
    fixture.allocation.releasedAt = new Date();
    fixture.allocation.releaseReason = 'order_cancel';
    const { manager, state } = createManager(fixture);
    const svc = createService();

    const result = await svc.releaseConfirmation(
      { orderId: 777, reason: 'order_cancel_retry', failedDeliveryIds: null },
      manager,
    );

    expect(result.alreadyReleased).toBe(true);
    expect(result.walletTransactionIds).toEqual([]);
    expect(state.txs).toHaveLength(0);
    expect(state.walletRef.depositBalance).toBe(1000);
  });

  it('Case C: throw injection — point_grant UPDATE affected=0 → throw, allocation save 0', async () => {
    const fixture = buildBaseFixture();
    const { manager, state } = createManager({ ...fixture, failPointUpdateForGrantId: 'g-1' });
    const svc = createService();

    await expect(
      svc.releaseConfirmation(
        { orderId: 777, reason: 'order_cancel', failedDeliveryIds: null },
        manager,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(state.savedAllocations).toHaveLength(0);
    expect(state.grantsRef[0].remainingAmount).toBe(0);
  });
});
