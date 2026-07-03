import { BadRequestException } from '@nestjs/common';
import { OrderDeliveryAttemptEntity } from '../../entity/order.delivery.attempt.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import { OrderPointUsageEntity } from '../../entity/order.point.usage.entity';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';
import { OrderConfirmationReleaseService } from './order-confirmation-release.service';

interface Ctx {
  wallet: any;
  alloc: OrderPaymentAllocationEntity;
  walletTxs: WalletTransactionEntity[];
  order: { id: number; userId: number; clientUserId: number | null };
  billingUserCode: string;
}

function makeManager(ctx: Ctx) {
  return {
    findOne: jest.fn(async (target: any) => {
      if (target === OrderPaymentAllocationEntity) return ctx.alloc;
      if (target === OrderEntity) return ctx.order;
      return null;
    }),
    find: jest.fn(async (target: any) => {
      if (target === OrderPointUsageEntity) return [];
      if (target === OrderDeliveryAttemptEntity) return [];
      return [];
    }),
    save: jest.fn(async (target: any, obj: any) => {
      if (target === WalletTransactionEntity) {
        const row = { id: String(ctx.walletTxs.length + 1), ...obj } as WalletTransactionEntity;
        ctx.walletTxs.push(row);
        return row;
      }
      return obj;
    }),
    getRepository: (target: any) => {
      if (target === UserEntity) {
        return { findOne: async () => ({ id: 1, settlementCode: ctx.billingUserCode }) };
      }
      return {
        createQueryBuilder: () => {
          const builder: any = {
            setLock: () => builder,
            where: () => builder,
            andWhere: () => builder,
            select: () => builder,
            getOne: jest.fn(async () => {
              if (target === WalletAccountEntity) return ctx.wallet;
              if (target === OrderPaymentAllocationEntity) return ctx.alloc;
              return null;
            }),
            getRawMany: jest.fn(async () => {
              if (target === OrderPaymentAllocationLineEntity) return [{ orderDeliveryId: 5001 }];
              return [];
            }),
          };
          return builder;
        },
      };
    },
  };
}

describe('OrderConfirmationReleaseService', () => {
  it('settled discard로 depositRestoredAmount가 depositUsedAmount를 초과해도 deposit을 이중 복구하지 않는다', async () => {
    const ctx: Ctx = {
      wallet: { id: '5', ownerId: 'company-1', depositBalance: 20000, creditUsedAmount: 0, creditExcessAmount: 0 },
      alloc: {
        id: '1',
        orderId: 700,
        walletAccountId: '5',
        depositUsedAmount: 0,
        depositRestoredAmount: 10000,
        creditUsedAmount: 0,
        creditUsedRestoredAmount: 0,
        creditExcessAmount: 0,
        creditExcessRestoredAmount: 0,
        pointRestoredAmount: 0,
        releasedAt: null,
        releaseReason: null,
      } as OrderPaymentAllocationEntity,
      walletTxs: [],
      order: { id: 700, userId: 1, clientUserId: null },
      billingUserCode: 'company-1',
    };
    const manager = makeManager(ctx);
    const sut = new OrderConfirmationReleaseService({} as any);

    const result = await sut.releaseConfirmation(
      { orderId: 700, reason: 'order_cancel', failedDeliveryIds: null },
      manager as any,
    );

    expect(result.walletTransactionIds).toEqual([]);
    expect(ctx.wallet.depositBalance).toBe(20000);
    expect(ctx.walletTxs.some((tx) => tx.resourceType === WalletResourceType.DEPOSIT)).toBe(false);
    expect(ctx.alloc.depositRestoredAmount).toBe(10000);
    expect(ctx.alloc.releasedAt).not.toBeNull();
  });

  it('H1: allocation wallet owner_id != billing user 현재 code → 보상 release BLOCK', async () => {
    const ctx: Ctx = {
      wallet: { id: '5', ownerId: 'company-1', depositBalance: 10000, creditUsedAmount: 0, creditExcessAmount: 0 },
      alloc: {
        id: '1',
        orderId: 700,
        walletAccountId: '5',
        depositUsedAmount: 10000,
        depositRestoredAmount: 0,
        creditUsedAmount: 0,
        creditUsedRestoredAmount: 0,
        creditExcessAmount: 0,
        creditExcessRestoredAmount: 0,
        pointRestoredAmount: 0,
        releasedAt: null,
        releaseReason: null,
      } as OrderPaymentAllocationEntity,
      walletTxs: [],
      order: { id: 700, userId: 1, clientUserId: null },
      billingUserCode: 'company-2', // 계정 이동됨.
    };
    const manager = makeManager(ctx);
    const sut = new OrderConfirmationReleaseService({} as any);

    await expect(
      sut.releaseConfirmation({ orderId: 700, reason: 'order_cancel', failedDeliveryIds: null }, manager as any),
    ).rejects.toThrow(/정산코드가 변경된 계정/);
    expect(ctx.walletTxs).toHaveLength(0);
    expect(ctx.alloc.releasedAt).toBeNull();
  });
});
