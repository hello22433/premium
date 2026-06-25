import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { SettleConfirmationWalletService } from './settle-confirmation-wallet.service';
import { WalletResourceType } from '../interface/wallet-resource-type';

/**
 * PR3 — SettleConfirmationWalletService (consensus plan v2.1 MAJOR fix 5).
 *  - settle_cycle_id = inline {orderId}_{seq} (race-free via wallet_account FOR UPDATE).
 *  - mirror owner = getBillingUserId(order) = order.clientUserId ?? order.userId.
 *  - Lock 순서 표준 §3 (wallet_account → allocation → wallet_transaction).
 */
describe('SettleConfirmationWalletService', () => {
  let sut: SettleConfirmationWalletService;
  let dataSource: any;

  type Fixture = {
    alloc: Partial<OrderPaymentAllocationEntity> | null;
    wallet: Partial<WalletAccountEntity> | null;
    order: Partial<OrderEntity> | null;
    /** sequence seed for COUNT(*) seq calc */
    settleTxCount: number;
    /** existing wallet_transaction rows for SETTLE_RELEASE / SETTLE_UNDO lookup */
    walletTxs: Partial<WalletTransactionEntity>[];
  };

  let fx: Fixture;
  const savedWalletTxs: any[] = [];
  const userUpdates: { id: number; expr: string; amount: number }[] = [];

  const makeManager = () => ({
    findOne: jest.fn(async (entity: any, opts: any) => {
      if (entity === OrderPaymentAllocationEntity) return fx.alloc ?? null;
      if (entity === OrderEntity) return fx.order ?? null;
      void opts;
      return null;
    }),
    save: jest.fn(async (entity: any, value: any) => {
      if (entity === WalletAccountEntity) {
        Object.assign(fx.wallet!, value);
        return fx.wallet;
      }
      if (entity === WalletTransactionEntity) {
        const row = { id: `tx-${savedWalletTxs.length + 1}`, ...value };
        savedWalletTxs.push(row);
        return row;
      }
      return value;
    }),
    getRepository: (entity: any) => {
      if (entity === WalletAccountEntity) {
        return {
          createQueryBuilder: () => ({
            setLock: () => ({
              where: () => ({ getOne: async () => fx.wallet ?? null }),
            }),
          }),
        };
      }
      if (entity === OrderPaymentAllocationEntity) {
        return {
          createQueryBuilder: () => ({
            setLock: () => ({
              where: () => ({ getOne: async () => fx.alloc ?? null }),
            }),
          }),
        };
      }
      if (entity === WalletTransactionEntity) {
        let typeFilter: string | null = null;
        let patFilter: string | null = null;
        const txChain: any = {
          select: () => txChain,
          where: () => txChain,
          andWhere: (_clause: string, params: any) => {
            if (params?.type) typeFilter = params.type;
            if (params?.pat) patFilter = params.pat;
            return txChain;
          },
          orderBy: () => txChain,
          getRawOne: async () => ({ cnt: String(fx.settleTxCount) }),
          getMany: async () => {
            const all = fx.walletTxs as any[];
            return all.filter((t) => {
              if (typeFilter && t.type !== typeFilter) return false;
              if (patFilter) {
                const suffix = patFilter.replace(/^%/, '');
                if (!String(t.idempotencyKey ?? '').endsWith(suffix)) return false;
              }
              return true;
            });
          },
        };
        return { createQueryBuilder: () => txChain };
      }
      if (entity === UserEntity) {
        return {
          createQueryBuilder: () => ({
            update: () => ({
              set: (patch: any) => ({
                where: (_clause: string, params: any) => ({
                  setParameters: (p2: any) => ({
                    execute: async () => {
                      userUpdates.push({
                        id: params.id,
                        expr: String(patch.allSettleAmount?.() ?? ''),
                        amount: p2.amount,
                      });
                      return { affected: 1 };
                    },
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return { createQueryBuilder: () => ({}) };
    },
  });

  beforeEach(async () => {
    fx = {
      alloc: null,
      wallet: null,
      order: null,
      settleTxCount: 0,
      walletTxs: [],
    };
    savedWalletTxs.length = 0;
    userUpdates.length = 0;

    dataSource = {
      transaction: jest.fn(async (cb: (m: any) => any) => cb(makeManager())),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [SettleConfirmationWalletService, { provide: getDataSourceToken(), useValue: dataSource }],
    }).compile();
    sut = module.get(SettleConfirmationWalletService);
  });

  it('confirmSettlement: credit + credit_excess 잔여 release + mirror 감소 + inline cycle id', async () => {
    fx.alloc = {
      walletAccountId: '5',
      creditUsedAmount: 7000,
      creditExcessAmount: 3000,
      creditUsedRestoredAmount: 0,
      creditExcessRestoredAmount: 0,
    };
    fx.wallet = { id: '5', creditUsedAmount: 7000, creditExcessAmount: 3000 };
    fx.order = { id: 100, userId: 1, clientUserId: 2 };
    fx.settleTxCount = 0; // 첫 cycle → seq=1

    const r = await sut.confirmSettlement(100);

    expect(r.creditReleased).toBe(7000);
    expect(r.excessReleased).toBe(3000);
    expect(r.settleCycleId).toBe('100_1');
    expect(r.walletTransactionIds).toHaveLength(2);

    // wallet_transaction insert (2 row)
    const creditTx = savedWalletTxs.find((t) => t.resourceType === WalletResourceType.CREDIT)!;
    expect(creditTx.idempotencyKey).toBe('settle_release:100::credit:100_1');
    expect(creditTx.amount).toBe(-7000);
    const excessTx = savedWalletTxs.find((t) => t.resourceType === WalletResourceType.CREDIT_EXCESS)!;
    expect(excessTx.idempotencyKey).toBe('settle_release:100::credit_excess:100_1');

    // wallet 잔액 감소
    expect(fx.wallet!.creditUsedAmount).toBe(0);
    expect(fx.wallet!.creditExcessAmount).toBe(0);

    // legacy mirror — billing user (clientUserId=2)
    expect(userUpdates).toHaveLength(1);
    expect(userUpdates[0].id).toBe(2);
    expect(userUpdates[0].amount).toBe(10000);
  });

  it('confirmSettlement: 재정산 시 seq 증가 (100_1 후 100_2)', async () => {
    fx.alloc = {
      walletAccountId: '5',
      creditUsedAmount: 1000,
      creditExcessAmount: 0,
      creditUsedRestoredAmount: 0,
      creditExcessRestoredAmount: 0,
    };
    fx.wallet = { id: '5', creditUsedAmount: 1000, creditExcessAmount: 0 };
    fx.order = { id: 100, userId: 1, clientUserId: null };
    fx.settleTxCount = 1; // 이전 1 row (settle_release 또는 settle_undo) 존재 → seq=2

    const r = await sut.confirmSettlement(100);
    expect(r.settleCycleId).toBe('100_2');
  });

  it('undoSettlement: 마지막 cycle lookup 후 same amount 복원 + mirror 증가', async () => {
    fx.alloc = {
      walletAccountId: '5',
      creditUsedAmount: 0,
      creditExcessAmount: 0,
      creditUsedRestoredAmount: 0,
      creditExcessRestoredAmount: 0,
    };
    fx.wallet = { id: '5', creditUsedAmount: 0, creditExcessAmount: 0 };
    fx.order = { id: 100, userId: 1, clientUserId: null };
    fx.walletTxs = [
      {
        id: 'tx-prev-1',
        orderId: 100,
        type: 'SETTLE_RELEASE',
        resourceType: WalletResourceType.CREDIT,
        amount: -7000,
        idempotencyKey: 'settle_release:100::credit:100_1',
      },
      {
        id: 'tx-prev-2',
        orderId: 100,
        type: 'SETTLE_RELEASE',
        resourceType: WalletResourceType.CREDIT_EXCESS,
        amount: -3000,
        idempotencyKey: 'settle_release:100::credit_excess:100_1',
      },
    ];

    const r = await sut.undoSettlement(100);
    expect(r.settleCycleId).toBe('100_1');
    expect(r.creditRestored).toBe(7000);
    expect(r.excessRestored).toBe(3000);

    // mirror — userId=1 (clientUserId null → userId)
    expect(userUpdates).toHaveLength(1);
    expect(userUpdates[0].id).toBe(1);
    expect(userUpdates[0].amount).toBe(10000);
  });

  it('undoSettlement: settle_release 부재 → BadRequest', async () => {
    fx.alloc = { walletAccountId: '5' };
    fx.wallet = { id: '5' };
    fx.order = { id: 404, userId: 1 };
    fx.walletTxs = [];

    await expect(sut.undoSettlement(404)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allocation 미존재 → BadRequest', async () => {
    fx.alloc = null;
    await expect(sut.confirmSettlement(999)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('credit/excess 모두 0 → wallet_transaction 0 row + mirror 미호출', async () => {
    fx.alloc = {
      walletAccountId: '5',
      creditUsedAmount: 0,
      creditExcessAmount: 0,
      creditUsedRestoredAmount: 0,
      creditExcessRestoredAmount: 0,
    };
    fx.wallet = { id: '5', creditUsedAmount: 0, creditExcessAmount: 0 };
    fx.order = { id: 100, userId: 1 };

    const r = await sut.confirmSettlement(100);
    expect(r.creditReleased).toBe(0);
    expect(r.excessReleased).toBe(0);
    expect(r.walletTransactionIds).toHaveLength(0);
    expect(savedWalletTxs).toHaveLength(0);
    expect(userUpdates).toHaveLength(0);
  });
});
