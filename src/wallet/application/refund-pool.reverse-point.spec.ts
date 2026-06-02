import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentRefundEventEntity } from '../../entity/order.payment.refund.event.entity';
import { OrderPointUsageEntity } from '../../entity/order.point.usage.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { PaymentAllocationService } from './payment-allocation.service';
import { RefundPoolService } from './refund-pool.service';
import { WalletResourceType } from '../interface/wallet-resource-type';

/**
 * PR-B2: reverseRefund POINT 대칭 역복구.
 *  - restored: forward POINT wallet_tx 재구성 → grant.remaining 재차감 + usage.restored 역복구 + 역행 tx.
 *  - skipped : usage.skipped 합계 분배 (Open 1) + audit row.
 *  - 다중 usage 행 (Open 4), 합계 불일치/conflict/shortfall fail-fast.
 */
describe('RefundPoolService.reverseRefund — POINT 대칭 역복구 (PR-B2)', () => {
  // ---- mutable stores ----
  let alloc: OrderPaymentAllocationEntity;
  let ledger: OrderPaymentRefundEventEntity;
  let grants: Record<string, PointGrantEntity>;
  let usages: OrderPointUsageEntity[];
  let walletTx: WalletTransactionEntity[];
  let sut: RefundPoolService;

  const LEDGER_KEY = 'fail_refund:100:100:7:line:10';

  // LIKE 'pat' ESCAPE '\' → escaped 리터럴 prefix(끝 % 제거) startsWith 매칭.
  const likeMatch = (key: string, pat: string): boolean => {
    const literal = pat.slice(0, -1).replace(/\\([\\%_])/g, '$1');
    return key.startsWith(literal);
  };

  const makeManager = () => {
    const captureBuilder = (target: any) => {
      const params: any = {};
      const builder: any = {
        setLock: () => builder,
        where: (_c: string, p?: any) => {
          Object.assign(params, p);
          return builder;
        },
        andWhere: (_c: string, p?: any) => {
          Object.assign(params, p);
          return builder;
        },
        orderBy: () => builder,
        addOrderBy: () => builder,
        getOne: async () => {
          if (target === OrderPaymentRefundEventEntity) return ledger;
          if (target === OrderPaymentAllocationEntity) return alloc;
          return null;
        },
        getMany: async () => {
          if (target === WalletTransactionEntity) {
            return walletTx.filter(
              (t) =>
                t.orderId === params.orderId &&
                t.orderDeliveryId === params.did &&
                t.resourceType === params.rt &&
                t.amount > 0 &&
                likeMatch(t.idempotencyKey, params.pat),
            );
          }
          return [];
        },
      };
      return builder;
    };

    const manager: any = {
      getRepository: (target: any) => ({ createQueryBuilder: () => captureBuilder(target) }),
      // 무인자 createQueryBuilder().update(PointGrant).set().where().execute()
      createQueryBuilder: () => {
        let updTarget: any = null;
        const whereParams: any = {};
        const ub: any = {
          update: (t: any) => {
            updTarget = t;
            return ub;
          },
          set: () => ub,
          where: (_c: string, p?: any) => {
            Object.assign(whereParams, p);
            return ub;
          },
          execute: async () => {
            if (updTarget === PointGrantEntity) {
              const g = grants[whereParams.id];
              if (g && g.active === 1 && g.remainingAmount >= whereParams.portion) {
                g.remainingAmount -= whereParams.portion;
                return { affected: 1 };
              }
              return { affected: 0 };
            }
            return { affected: 0 };
          },
        };
        return ub;
      },
      find: async (target: any, opts: any) => {
        if (target === OrderPointUsageEntity) {
          let rows = usages.filter((u) => u.allocationId === opts.where.allocationId);
          if (opts.where.pointGrantId !== undefined) {
            rows = rows.filter((u) => u.pointGrantId === opts.where.pointGrantId);
          }
          return rows.slice().sort((a, b) => Number(a.id) - Number(b.id));
        }
        return [];
      },
      findOne: async (target: any, opts: any) => {
        if (target === PointGrantEntity) return grants[opts.where.id] ?? null;
        return null;
      },
      save: jest.fn(async (target: any, obj: any) => {
        if (target === WalletTransactionEntity) {
          const row = { id: String(walletTx.length + 1), ...obj } as WalletTransactionEntity;
          walletTx.push(row);
          return row;
        }
        return obj;
      }),
    };
    return manager;
  };

  const ds: any = {
    transaction: jest.fn(async (...args: any[]) => {
      const cb = (typeof args[0] === 'function' ? args[0] : args[1]) as (m: any) => any;
      return cb(makeManager());
    }),
  };

  beforeEach(async () => {
    alloc = {
      id: '1',
      orderId: 100,
      walletAccountId: '5',
      pointRestoredAmount: 0,
      creditExcessRestoredAmount: 0,
      creditUsedRestoredAmount: 0,
      depositRestoredAmount: 0,
      pointSkippedExpiredAmount: 0,
    } as OrderPaymentAllocationEntity;
    ledger = {
      id: 'lg-1',
      allocationId: '1',
      orderId: 100,
      affectedDeliveryIds: [100],
      refundedPointAmount: 0,
      refundedCreditExcessAmount: 0,
      refundedCreditUsedAmount: 0,
      refundedDepositAmount: 0,
      pointSkippedExpiredAmount: 0,
      idempotencyKey: LEDGER_KEY,
      reversedAt: null,
      reversedByWalletTransactionId: null,
    } as OrderPaymentRefundEventEntity;
    grants = {};
    usages = [];
    walletTx = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundPoolService,
        PaymentAllocationService,
        { provide: getDataSourceToken(), useValue: ds as Partial<DataSource> },
      ],
    }).compile();
    sut = module.get(RefundPoolService);
  });

  const fwdPointTx = (grantId: string, amount: number) =>
    walletTx.push({
      id: String(walletTx.length + 1),
      walletAccountId: '5',
      orderId: 100,
      orderDeliveryId: 100,
      resourceType: WalletResourceType.POINT,
      amount,
      balanceAfter: amount,
      type: 'FAIL_REFUND',
      idempotencyKey: `${LEDGER_KEY}:point:${grantId}`,
    } as WalletTransactionEntity);

  it('restored 단일 grant/usage — grant.remaining 재차감 + usage.restored 0 + 역행 tx(-portion)', async () => {
    alloc.pointRestoredAmount = 3000;
    ledger.refundedPointAmount = 3000;
    grants['g1'] = { id: 'g1', remainingAmount: 3000, active: 1 } as PointGrantEntity;
    usages = [{ id: '1', allocationId: '1', pointGrantId: 'g1', usedAmount: 3000, restoredAmount: 3000, skippedExpiredAmount: 0 } as OrderPointUsageEntity];
    fwdPointTx('g1', 3000);

    const r = await sut.reverseRefund('lg-1', 'tx-99');

    expect(r.alreadyReversed).toBe(false);
    expect(grants['g1'].remainingAmount).toBe(0);
    expect(usages[0].restoredAmount).toBe(0);
    expect(alloc.pointRestoredAmount).toBe(0);
    const rev = walletTx.find((t) => t.idempotencyKey === 'resend_deduct:100:100:point:g1:tx-99');
    expect(rev).toBeDefined();
    expect(rev!.amount).toBe(-3000);
    expect(rev!.type).toBe('RESEND_DEDUCT');
    expect(rev!.balanceAfter).toBe(0);
    expect(ledger.reversedAt).not.toBeNull();
  });

  it('restored 같은 grant 다중 usage 행 (Open 4) — id ASC greedy 로 둘 다 차감', async () => {
    alloc.pointRestoredAmount = 3000;
    ledger.refundedPointAmount = 3000;
    grants['g1'] = { id: 'g1', remainingAmount: 3000, active: 1 } as PointGrantEntity;
    usages = [
      { id: '1', allocationId: '1', pointGrantId: 'g1', usedAmount: 2000, restoredAmount: 2000, skippedExpiredAmount: 0 } as OrderPointUsageEntity,
      { id: '2', allocationId: '1', pointGrantId: 'g1', usedAmount: 1000, restoredAmount: 1000, skippedExpiredAmount: 0 } as OrderPointUsageEntity,
    ];
    fwdPointTx('g1', 3000);

    await sut.reverseRefund('lg-1', 'tx-99');

    expect(usages[0].restoredAmount).toBe(0);
    expect(usages[1].restoredAmount).toBe(0);
    expect(grants['g1'].remainingAmount).toBe(0);
  });

  it('restored 다중 grant — grant 별 portion 각각 역복구', async () => {
    alloc.pointRestoredAmount = 5000;
    ledger.refundedPointAmount = 5000;
    grants['g1'] = { id: 'g1', remainingAmount: 3000, active: 1 } as PointGrantEntity;
    grants['g2'] = { id: 'g2', remainingAmount: 2000, active: 1 } as PointGrantEntity;
    usages = [
      { id: '1', allocationId: '1', pointGrantId: 'g1', usedAmount: 3000, restoredAmount: 3000, skippedExpiredAmount: 0 } as OrderPointUsageEntity,
      { id: '2', allocationId: '1', pointGrantId: 'g2', usedAmount: 2000, restoredAmount: 2000, skippedExpiredAmount: 0 } as OrderPointUsageEntity,
    ];
    fwdPointTx('g1', 3000);
    fwdPointTx('g2', 2000);

    await sut.reverseRefund('lg-1', 'tx-99');

    expect(grants['g1'].remainingAmount).toBe(0);
    expect(grants['g2'].remainingAmount).toBe(0);
    expect(usages[0].restoredAmount).toBe(0);
    expect(usages[1].restoredAmount).toBe(0);
    expect(walletTx.filter((t) => t.type === 'RESEND_DEDUCT' && t.amount < 0)).toHaveLength(2);
  });

  it('skipped-expired 역복구 (Open 1) — usage.skipped 0 + alloc.skipped 차감 + audit row(amount=0)', async () => {
    alloc.pointSkippedExpiredAmount = 1000;
    ledger.pointSkippedExpiredAmount = 1000;
    usages = [{ id: '1', allocationId: '1', pointGrantId: 'g1', usedAmount: 1000, restoredAmount: 0, skippedExpiredAmount: 1000 } as OrderPointUsageEntity];

    await sut.reverseRefund('lg-1', 'tx-99');

    expect(usages[0].skippedExpiredAmount).toBe(0);
    expect(alloc.pointSkippedExpiredAmount).toBe(0);
    const audit = walletTx.find((t) => t.idempotencyKey === 'resend_deduct:100:100:point_skipped_expired:tx-99');
    expect(audit).toBeDefined();
    expect(audit!.amount).toBe(0);
    expect(audit!.type).toBe('RESEND_DEDUCT');
  });

  it('restored + skipped 혼합 — 둘 다 역복구되어 usageRemaining 이 used 로 복귀', async () => {
    alloc.pointRestoredAmount = 2000;
    alloc.pointSkippedExpiredAmount = 1000;
    ledger.refundedPointAmount = 2000;
    ledger.pointSkippedExpiredAmount = 1000;
    grants['g1'] = { id: 'g1', remainingAmount: 2000, active: 1 } as PointGrantEntity;
    // u1: 비만료 grant g1 restored. u2: 만료 grant skip.
    usages = [
      { id: '1', allocationId: '1', pointGrantId: 'g1', usedAmount: 2000, restoredAmount: 2000, skippedExpiredAmount: 0 } as OrderPointUsageEntity,
      { id: '2', allocationId: '1', pointGrantId: 'g2', usedAmount: 1000, restoredAmount: 0, skippedExpiredAmount: 1000 } as OrderPointUsageEntity,
    ];
    fwdPointTx('g1', 2000);

    await sut.reverseRefund('lg-1', 'tx-99');

    // usageRemaining = used - restored - skipped 가 used 로 복귀.
    expect(usages[0].usedAmount - usages[0].restoredAmount - usages[0].skippedExpiredAmount).toBe(2000);
    expect(usages[1].usedAmount - usages[1].restoredAmount - usages[1].skippedExpiredAmount).toBe(1000);
  });

  it('재구성 합계 불일치 → fail-fast', async () => {
    alloc.pointRestoredAmount = 3000;
    ledger.refundedPointAmount = 3000;
    grants['g1'] = { id: 'g1', remainingAmount: 2000, active: 1 } as PointGrantEntity;
    usages = [{ id: '1', allocationId: '1', pointGrantId: 'g1', usedAmount: 2000, restoredAmount: 2000, skippedExpiredAmount: 0 } as OrderPointUsageEntity];
    fwdPointTx('g1', 2000); // ledger 는 3000 인데 tx 합계 2000

    await expect(sut.reverseRefund('lg-1', 'tx-99')).rejects.toThrow(/합계 불일치/);
  });

  it('grant remaining<portion or active=0 → conflict fail-fast', async () => {
    alloc.pointRestoredAmount = 3000;
    ledger.refundedPointAmount = 3000;
    grants['g1'] = { id: 'g1', remainingAmount: 1000, active: 1 } as PointGrantEntity; // < 3000
    usages = [{ id: '1', allocationId: '1', pointGrantId: 'g1', usedAmount: 3000, restoredAmount: 3000, skippedExpiredAmount: 0 } as OrderPointUsageEntity];
    fwdPointTx('g1', 3000);

    await expect(sut.reverseRefund('lg-1', 'tx-99')).rejects.toThrow(/conflict/);
  });

  it('usage.restored 합계 부족 → shortfall fail-fast', async () => {
    alloc.pointRestoredAmount = 3000;
    ledger.refundedPointAmount = 3000;
    grants['g1'] = { id: 'g1', remainingAmount: 3000, active: 1 } as PointGrantEntity;
    usages = [{ id: '1', allocationId: '1', pointGrantId: 'g1', usedAmount: 2000, restoredAmount: 2000, skippedExpiredAmount: 0 } as OrderPointUsageEntity]; // < 3000
    fwdPointTx('g1', 3000);

    await expect(sut.reverseRefund('lg-1', 'tx-99')).rejects.toThrow(/usage 역복구 부족/);
  });

  it('멱등 — ledger.reversedAt 이미 set → no-op (grant/usage 미변경)', async () => {
    ledger.reversedAt = new Date();
    ledger.refundedPointAmount = 3000;
    grants['g1'] = { id: 'g1', remainingAmount: 3000, active: 1 } as PointGrantEntity;
    usages = [{ id: '1', allocationId: '1', pointGrantId: 'g1', usedAmount: 3000, restoredAmount: 3000, skippedExpiredAmount: 0 } as OrderPointUsageEntity];
    fwdPointTx('g1', 3000);

    const r = await sut.reverseRefund('lg-1', 'tx-99');

    expect(r.alreadyReversed).toBe(true);
    expect(grants['g1'].remainingAmount).toBe(3000);
    expect(usages[0].restoredAmount).toBe(3000);
    expect(walletTx.filter((t) => t.type === 'RESEND_DEDUCT')).toHaveLength(0);
  });
});
