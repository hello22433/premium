import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import {
  OrderPaymentRefundEventEntity,
  OrderPaymentRefundEventType,
} from '../../entity/order.payment.refund.event.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';
import { PaymentAllocationService } from './payment-allocation.service';
import { RefundPoolService } from './refund-pool.service';

/**
 * §8 환불 알고리즘 검증 (풀 기반 + ledger).
 * 우선순위: 포인트 → 신용초과 → 여신 → 예치금.
 */
describe('RefundPoolService — §8 환불 알고리즘', () => {
  let sut: RefundPoolService;
  let allocations: Record<string, OrderPaymentAllocationEntity>;
  let lines: OrderPaymentAllocationLineEntity[];
  let ledger: OrderPaymentRefundEventEntity[];
  let walletTxs: WalletTransactionEntity[];
  let wallets: Record<string, WalletAccountEntity>;
  // reverseRefund 의 ledger lookup(getOne) 이 반환할 fixture. 기본 null = ledger 미존재.
  let reverseLedger: OrderPaymentRefundEventEntity | null;

  const ds: any = {
    // transaction 은 isolationLevel 1st arg + callback 또는 callback 단독 둘 다 지원
    transaction: jest.fn(async (...args: any[]) => {
      const cb = (typeof args[0] === 'function' ? args[0] : args[1]) as (m: any) => any;
      const manager = {
        getRepository: (target: any) => ({
          createQueryBuilder: (_alias: string) => {
            // where 조건을 캡처해서 prefix LIKE 분기 처리
            let wherePrefix: string | null = null;
            const builder: any = {
              setLock: () => builder,
              where: (cond: string, params?: any) => {
                if (typeof cond === 'string' && cond.includes('LIKE') && params?.prefix) {
                  wherePrefix = String(params.prefix).replace(/%$/, '');
                }
                return builder;
              },
              andWhere: () => builder,
              orderBy: () => builder,
              addOrderBy: () => builder,
              getOne: async () => {
                if (target === WalletAccountEntity) {
                  return Object.values(wallets)[0] ?? null;
                }
                if (target === OrderPaymentRefundEventEntity) {
                  // reverseRefund 의 ledger lookup. reverseLedger fixture 반환 (기본 null = 미존재).
                  return reverseLedger;
                }
                return Object.values(allocations)[0];
              },
              getMany: async () => {
                if (target === OrderPaymentRefundEventEntity) {
                  if (wherePrefix) {
                    return ledger.filter((l) => (l.idempotencyKey ?? '').startsWith(wherePrefix as string));
                  }
                  return ledger.filter((l) => l.reversedAt === null);
                }
                if (target === OrderPaymentAllocationLineEntity) return lines;
                return [];
              },
            };
            return builder;
          },
        }),
        find: async (target: any, _where: any) => {
          if (target === OrderPaymentRefundEventEntity) return ledger.filter((l) => l.reversedAt === null);
          return [];
        },
        findOne: async (target: any, opts: any) => {
          if (target === OrderPaymentAllocationEntity) {
            if (opts?.where?.orderId !== undefined) {
              return (
                Object.values(allocations).find((a) => a.orderId === opts.where.orderId) ?? null
              );
            }
            return Object.values(allocations)[0] ?? null;
          }
          return null;
        },
        save: jest.fn(async (target: any, obj: any) => {
          if (target === OrderPaymentRefundEventEntity || obj?.refundedGrossBase != null) {
            const row = { id: String(ledger.length + 1), ...obj } as OrderPaymentRefundEventEntity;
            ledger.push(row);
            return row;
          }
          if (target === WalletTransactionEntity || obj?.walletAccountId != null) {
            const row = { id: String(walletTxs.length + 1), ...obj } as WalletTransactionEntity;
            walletTxs.push(row);
            return row;
          }
          if (target === OrderPaymentAllocationEntity || obj?.grossSettlementAmount != null) {
            allocations[obj.id] = obj;
            return obj;
          }
          if (target === WalletAccountEntity || obj?.depositBalance != null) {
            wallets[obj.id] = obj;
            return obj;
          }
          return obj;
        }),
      };
      return cb(manager);
    }),
  };

  beforeEach(async () => {
    allocations = {
      '1': {
        id: '1',
        orderId: 100,
        walletAccountId: '5',
        grossSettlementAmount: 30000,
        pointUsedAmount: 0,
        payableSettlementAmount: 30000,
        depositUsedAmount: 10000,
        creditUsedAmount: 15000,
        creditExcessAmount: 5000,
        cardSurchargeAmount: 0,
        cardSurchargeApplied: 0,
        hasDiscount: 0,
        settleMethodSnapshot: null,
        pointRestoredAmount: 0,
        creditExcessRestoredAmount: 0,
        creditUsedRestoredAmount: 0,
        depositRestoredAmount: 0,
        pointSkippedExpiredAmount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as OrderPaymentAllocationEntity,
    };
    lines = [
      {
        id: '10',
        allocationId: '1',
        orderId: 100,
        orderProductMappingId: 1,
        orderDeliveryId: 100,
        productId: null,
        brandId: null,
        category: null,
        partnerCompanyId: null,
        orderType: 'GENERAL',
        grossSettlementAmount: 10000,
        appliedFeePercent: null,
        appliedPriceAdjustment: null,
        pointUsedAmount: 0,
        payableBase: 10000,
        depositUsedAmount: 0,
        creditUsedAmount: 0,
        creditExcessAmount: 0,
        createdAt: new Date(),
      } as OrderPaymentAllocationLineEntity,
    ];
    ledger = [];
    walletTxs = [];
    reverseLedger = null;
    wallets = {
      '5': {
        id: '5',
        ownerType: 'SETTLEMENT_CODE',
        settlementCode: 'company-1',
        depositBalance: 0,
        creditLimit: 100000,
        creditUsedAmount: 15000,
        creditExcessAmount: 5000,
        settleCondition: 'POST_PAYMENT',
        settleMethod: 'CASH',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as WalletAccountEntity,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundPoolService,
        PaymentAllocationService,
        { provide: getDataSourceToken(), useValue: ds as Partial<DataSource> },
      ],
    }).compile();
    sut = module.get(RefundPoolService);
  });

  it('환불 우선순위 = 신용초과 → 여신 → 예치금 (포인트 없음)', async () => {
    const r = await sut.refund({
      orderId: 100,
      eventType: OrderPaymentRefundEventType.FAIL_REFUND,
      targetDeliveryIds: [100],
      idempotencyKeyPrefix: 'fail_refund:100:100:1',
    });
    expect(r.ledgerIds.length).toBe(1);
    const row = ledger[0];
    expect(row.refundedGrossBase).toBe(10000);
    expect(row.refundedCreditExcessAmount).toBe(5000); // 신용초과 먼저
    expect(row.refundedCreditUsedAmount).toBe(5000); // 그 다음 여신
    expect(row.refundedDepositAmount).toBe(0); // 예치금은 마지막 (이 환불에서는 도달 안 함)
    expect(row.refundedPointAmount).toBe(0);
  });

  it('already_refunded → BadRequest', async () => {
    ledger.push({
      id: 'pre1',
      allocationId: '1',
      orderId: 100,
      eventType: OrderPaymentRefundEventType.FAIL_REFUND,
      affectedDeliveryIds: [100],
      refundedGrossBase: 10000,
      refundedPayableBase: 10000,
      refundedCardSurchargeAmount: 0,
      refundedPointAmount: 0,
      refundedDepositAmount: 0,
      refundedCreditUsedAmount: 5000,
      refundedCreditExcessAmount: 5000,
      pointSkippedExpiredAmount: 0,
      idempotencyKey: 'fail_refund:100:100:0:line:10',
      reversedAt: null,
      reversedByWalletTransactionId: null,
      createdAt: new Date(),
    } as OrderPaymentRefundEventEntity);
    await expect(
      sut.refund({
        orderId: 100,
        eventType: OrderPaymentRefundEventType.FAIL_REFUND,
        targetDeliveryIds: [100],
        idempotencyKeyPrefix: 'fail_refund:100:100:1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('동일 idempotencyKeyPrefix retry → throw 없이 기존 ledger return (retry idempotency)', async () => {
    ledger.push({
      id: 'pre1',
      allocationId: '1',
      orderId: 100,
      eventType: OrderPaymentRefundEventType.FAIL_REFUND,
      affectedDeliveryIds: [100],
      refundedGrossBase: 10000,
      refundedPayableBase: 10000,
      refundedCardSurchargeAmount: 0,
      refundedPointAmount: 0,
      refundedDepositAmount: 0,
      refundedCreditUsedAmount: 5000,
      refundedCreditExcessAmount: 5000,
      pointSkippedExpiredAmount: 0,
      idempotencyKey: 'fail_refund:100:100:1:line:10',
      reversedAt: null,
      reversedByWalletTransactionId: null,
      createdAt: new Date(),
    } as OrderPaymentRefundEventEntity);

    const r = await sut.refund({
      orderId: 100,
      eventType: OrderPaymentRefundEventType.FAIL_REFUND,
      targetDeliveryIds: [100],
      idempotencyKeyPrefix: 'fail_refund:100:100:1',
    });
    expect(r.ledgerIds).toEqual(['pre1']);
    expect(r.totalRefundedAmount).toBe(10000);
  });

  it('정산확정 후 폐기 환불은 여신/신용초과를 다시 release하지 않고 예치금으로 환불한다', async () => {
    wallets['5'].creditUsedAmount = 0;
    wallets['5'].creditExcessAmount = 0;

    const r = await sut.refundSettledDiscardToDeposit({
      orderId: 100,
      orderDeliveryId: 100,
      refundAmount: 10000,
      idempotencyKeyPrefix: 'discard_refund:100:100:deposit:1',
    });

    expect(r.ledgerIds.length).toBe(1);
    expect(r.totalRefundedAmount).toBe(10000);
    expect(wallets['5'].depositBalance).toBe(10000);
    expect(wallets['5'].creditUsedAmount).toBe(0);
    expect(wallets['5'].creditExcessAmount).toBe(0);
    expect(allocations['1'].creditUsedRestoredAmount).toBe(0);
    expect(allocations['1'].creditExcessRestoredAmount).toBe(0);
    expect(ledger[0]).toEqual(expect.objectContaining({
      eventType: OrderPaymentRefundEventType.DISCARD_REFUND,
      affectedDeliveryIds: [100],
      refundedDepositAmount: 10000,
      refundedCreditUsedAmount: 0,
      refundedCreditExcessAmount: 0,
      idempotencyKey: 'discard_refund:100:100:deposit:1:settled',
    }));
    expect(walletTxs[0]).toEqual(expect.objectContaining({
      type: 'DISCARD_REFUND',
      resourceType: WalletResourceType.DEPOSIT,
      amount: 10000,
      balanceAfter: 10000,
      idempotencyKey: 'discard_refund:100:100:deposit:1:settled:wallet',
    }));
  });

  it('정산확정 후 폐기 환불 retry는 예치금을 중복 증가시키지 않는다', async () => {
    const input = {
      orderId: 100,
      orderDeliveryId: 100,
      refundAmount: 10000,
      idempotencyKeyPrefix: 'discard_refund:100:100:deposit:1',
    };

    await sut.refundSettledDiscardToDeposit(input);
    const r = await sut.refundSettledDiscardToDeposit(input);

    expect(r.ledgerIds).toEqual(['1']);
    expect(r.totalRefundedAmount).toBe(10000);
    expect(wallets['5'].depositBalance).toBe(10000);
    expect(walletTxs.length).toBe(1);
    expect(ledger.length).toBe(1);
  });

  it('reverseRefund: ledger 미존재 → BadRequest', async () => {
    await expect(sut.reverseRefund('missing-ledger', 'tx-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('reverseRefund: ledger 금액 > allocation 복구 counter 면 invariant 위반 throw (clamp 금지)', async () => {
    // alloc.pointRestoredAmount=0(default) 인데 ledger.refundedPointAmount=5000 → data drift.
    // 과거엔 Math.max(0,...) 로 조용히 0 clamp 됐으나 이제 fail-fast.
    reverseLedger = {
      id: 'lg-1',
      allocationId: '1',
      orderId: 100,
      refundedPointAmount: 5000,
      refundedCreditExcessAmount: 0,
      refundedCreditUsedAmount: 0,
      refundedDepositAmount: 0,
      pointSkippedExpiredAmount: 0,
      reversedAt: null,
      reversedByWalletTransactionId: null,
    } as OrderPaymentRefundEventEntity;

    await expect(sut.reverseRefund('lg-1', 'tx-9')).rejects.toThrow(/invariant/);
  });

  it('reverseRefund: 정상 — ledger 금액만큼 복구 counter 차감 + reversedAt set', async () => {
    allocations['1'].creditUsedRestoredAmount = 5000;
    allocations['1'].creditExcessRestoredAmount = 5000;
    reverseLedger = {
      id: 'lg-2',
      allocationId: '1',
      orderId: 100,
      refundedPointAmount: 0,
      refundedCreditExcessAmount: 5000,
      refundedCreditUsedAmount: 5000,
      refundedDepositAmount: 0,
      pointSkippedExpiredAmount: 0,
      reversedAt: null,
      reversedByWalletTransactionId: null,
    } as OrderPaymentRefundEventEntity;

    const r = await sut.reverseRefund('lg-2', 'tx-10');

    expect(r.alreadyReversed).toBe(false);
    expect(allocations['1'].creditUsedRestoredAmount).toBe(0);
    expect(allocations['1'].creditExcessRestoredAmount).toBe(0);
    expect(reverseLedger!.reversedAt).not.toBeNull();
    expect(reverseLedger!.reversedByWalletTransactionId).toBe('tx-10');
  });
});
