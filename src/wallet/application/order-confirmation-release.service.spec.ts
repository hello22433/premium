import { OrderDeliveryAttemptEntity } from '../../entity/order.delivery.attempt.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import { OrderPointUsageEntity } from '../../entity/order.point.usage.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';
import { OrderConfirmationReleaseService } from './order-confirmation-release.service';

describe('OrderConfirmationReleaseService', () => {
  it('settled discard로 depositRestoredAmount가 depositUsedAmount를 초과해도 deposit을 이중 복구하지 않는다', async () => {
    const wallet = {
      id: '5',
      depositBalance: 20000,
      creditUsedAmount: 0,
      creditExcessAmount: 0,
    } as unknown as WalletAccountEntity;
    const alloc = {
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
    } as OrderPaymentAllocationEntity;
    const walletTxs: WalletTransactionEntity[] = [];

    const manager: any = {
      findOne: jest.fn(async (target: any) => {
        if (target === OrderPaymentAllocationEntity) return alloc;
        return null;
      }),
      find: jest.fn(async (target: any) => {
        if (target === OrderPointUsageEntity) return [];
        if (target === OrderDeliveryAttemptEntity) return [];
        return [];
      }),
      save: jest.fn(async (target: any, obj: any) => {
        if (target === WalletTransactionEntity) {
          const row = { id: String(walletTxs.length + 1), ...obj } as WalletTransactionEntity;
          walletTxs.push(row);
          return row;
        }
        return obj;
      }),
      getRepository: (target: any) => ({
        createQueryBuilder: () => {
          const builder: any = {
            setLock: () => builder,
            where: () => builder,
            andWhere: () => builder,
            select: () => builder,
            getOne: jest.fn(async () => {
              if (target === WalletAccountEntity) return wallet;
              if (target === OrderPaymentAllocationEntity) return alloc;
              return null;
            }),
            getRawMany: jest.fn(async () => {
              if (target === OrderPaymentAllocationLineEntity) return [{ orderDeliveryId: 5001 }];
              return [];
            }),
          };
          return builder;
        },
      }),
    };

    const sut = new OrderConfirmationReleaseService({} as any);

    const result = await sut.releaseConfirmation(
      { orderId: 700, reason: 'order_cancel', failedDeliveryIds: null },
      manager,
    );

    expect(result.walletTransactionIds).toEqual([]);
    expect(wallet.depositBalance).toBe(20000);
    expect(walletTxs.some((tx) => tx.resourceType === WalletResourceType.DEPOSIT)).toBe(false);
    expect(alloc.depositRestoredAmount).toBe(10000);
    expect(alloc.releasedAt).not.toBeNull();
  });
});
