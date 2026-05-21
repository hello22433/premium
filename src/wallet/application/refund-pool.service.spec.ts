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

  const ds: any = {
    transaction: jest.fn(async (cb: (m: any) => any) => {
      const manager = {
        getRepository: (target: any) => ({
          createQueryBuilder: (alias: string) => {
            const builder: any = {
              setLock: () => builder,
              where: () => builder,
              andWhere: () => builder,
              orderBy: () => builder,
              addOrderBy: () => builder,
              getOne: async () => Object.values(allocations)[0],
              getMany: async () => lines,
            };
            return builder;
          },
        }),
        find: async (target: any, where: any) => {
          if (target === OrderPaymentRefundEventEntity) return ledger.filter((l) => l.reversedAt === null);
          return [];
        },
        findOne: async (_t: any, _w: any) => null,
        save: jest.fn(async (target: any, obj: any) => {
          if (target === OrderPaymentRefundEventEntity || obj?.refundedGrossBase != null) {
            const row = { id: String(ledger.length + 1), ...obj } as OrderPaymentRefundEventEntity;
            ledger.push(row);
            return row;
          }
          if (target === OrderPaymentAllocationEntity || obj?.grossSettlementAmount != null) {
            allocations[obj.id] = obj;
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
});
