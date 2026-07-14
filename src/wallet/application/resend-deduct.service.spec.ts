import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';
import { ResendDeductService } from './resend-deduct.service';
import { WalletResourceType } from '../interface/wallet-resource-type';

/**
 * PR4 ResendDeductService — 재발송 차감 / undo (plan §2 resend_deduct/resend_undo).
 *   - attemptId cycle 멱등 (같은 attempt 재호출 = 같은 idempotencyKey).
 *   - 차감 금액은 caller 가 전달한 reversed ledger 금액 그대로 사용 (line 분배 아님, §8 재계산 X).
 *   - Lock 표준 §3 (wallet_account → allocation → wallet_transaction).
 */
describe('ResendDeductService', () => {
  let sut: ResendDeductService;
  let dataSource: any;

  type Fixture = {
    alloc: Partial<OrderPaymentAllocationEntity> | null;
    wallet: Partial<WalletAccountEntity> | null;
    line: Partial<OrderPaymentAllocationLineEntity> | null;
    /** H1 가드용 — billing user 현재 settlement_code (미지정 시 wallet.ownerId 와 매칭). */
    billingUserCode?: string;
  };

  let fx: Fixture;
  const savedWalletTxs: any[] = [];

  const makeManager = () => ({
    findOne: jest.fn(async (entity: any, opts: any) => {
      if (entity === OrderPaymentAllocationEntity) return fx.alloc ?? null;
      if (entity === OrderPaymentAllocationLineEntity) {
        if (opts?.where?.orderDeliveryId === fx.line?.orderDeliveryId) return fx.line ?? null;
        return null;
      }
      if (entity === OrderEntity) return { id: opts?.where?.id ?? 777, userId: 1, clientUserId: null };
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
      if (entity === UserEntity) {
        return {
          findOne: async () => ({
            id: 1,
            settlementCode: fx.billingUserCode !== undefined ? fx.billingUserCode : (fx.wallet?.ownerId ?? ''),
          }),
        };
      }
      return {
        createQueryBuilder: () => ({
          setLock: () => ({
            where: () => ({
              getOne: async () => {
                if (entity === WalletAccountEntity) return fx.wallet ?? null;
                if (entity === OrderPaymentAllocationEntity) return fx.alloc ?? null;
                return null;
              },
            }),
          }),
        }),
      };
    },
  });

  beforeEach(async () => {
    fx = { alloc: null, wallet: null, line: null };
    savedWalletTxs.length = 0;
    dataSource = {
      transaction: jest.fn(async (cb: (m: any) => any) => cb(makeManager())),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [ResendDeductService, { provide: getDataSourceToken(), useValue: dataSource }],
    }).compile();
    sut = module.get(ResendDeductService);
  });

  it('resendDeduct: deposit/credit/excess 재차감 + wallet_transaction 3 row + cycle=attemptId', async () => {
    fx.alloc = { id: 'a-1', walletAccountId: 'w-1' };
    fx.wallet = { id: 'w-1', depositBalance: 10000, creditUsedAmount: 0, creditExcessAmount: 0 };
    // line 은 존재 가드용으로만 필요 (금액은 입력으로 전달). line 분배 값은 의도적으로 입력과 다르게 둠.
    fx.line = {
      allocationId: 'a-1',
      orderDeliveryId: 101,
      depositUsedAmount: 1,
      creditUsedAmount: 1,
      creditExcessAmount: 1,
    };

    const r = await sut.resendDeduct({
      orderId: 777,
      orderDeliveryId: 101,
      attemptId: 'att-42',
      depositAmount: 5000,
      creditAmount: 3000,
      excessAmount: 1000,
    });

    expect(r.deducted).toEqual({ deposit: 5000, credit: 3000, excess: 1000 });
    expect(r.walletTransactionIds).toHaveLength(3);
    // wallet 잔액
    expect(fx.wallet!.depositBalance).toBe(5000);
    expect(fx.wallet!.creditUsedAmount).toBe(3000);
    expect(fx.wallet!.creditExcessAmount).toBe(1000);
    // wallet_transaction 멱등키 = resend_deduct:{orderId}:{deliveryId}:{resource}:{attemptId}
    expect(savedWalletTxs.find((t) => t.resourceType === WalletResourceType.DEPOSIT).idempotencyKey).toBe(
      'resend_deduct:777:101:deposit:att-42',
    );
    expect(savedWalletTxs.find((t) => t.resourceType === WalletResourceType.CREDIT).idempotencyKey).toBe(
      'resend_deduct:777:101:credit:att-42',
    );
    expect(savedWalletTxs.find((t) => t.resourceType === WalletResourceType.CREDIT_EXCESS).idempotencyKey).toBe(
      'resend_deduct:777:101:credit_excess:att-42',
    );
  });

  it('resendUndo: deposit/credit/excess 복원 (resendDeduct 의 역)', async () => {
    fx.alloc = { id: 'a-1', walletAccountId: 'w-1' };
    fx.wallet = { id: 'w-1', depositBalance: 5000, creditUsedAmount: 3000, creditExcessAmount: 1000 };
    fx.line = {
      allocationId: 'a-1',
      orderDeliveryId: 101,
      depositUsedAmount: 1,
      creditUsedAmount: 1,
      creditExcessAmount: 1,
    };

    const r = await sut.resendUndo({
      orderId: 777,
      orderDeliveryId: 101,
      attemptId: 'att-42',
      depositAmount: 5000,
      creditAmount: 3000,
      excessAmount: 1000,
    });

    expect(r.deducted).toEqual({ deposit: 5000, credit: 3000, excess: 1000 });
    expect(fx.wallet!.depositBalance).toBe(10000);
    expect(fx.wallet!.creditUsedAmount).toBe(0);
    expect(fx.wallet!.creditExcessAmount).toBe(0);
    expect(savedWalletTxs.find((t) => t.resourceType === WalletResourceType.DEPOSIT).idempotencyKey).toBe(
      'resend_undo:777:101:deposit:att-42',
    );
  });

  it('allocation 미존재 → BadRequest', async () => {
    fx.alloc = null;
    await expect(
      sut.resendDeduct({
        orderId: 999,
        orderDeliveryId: 1,
        attemptId: 'a',
        depositAmount: 1,
        creditAmount: 0,
        excessAmount: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('line 미존재 → BadRequest', async () => {
    fx.alloc = { id: 'a-1', walletAccountId: 'w-1' };
    fx.wallet = { id: 'w-1' };
    fx.line = null;
    await expect(
      sut.resendDeduct({
        orderId: 777,
        orderDeliveryId: 999,
        attemptId: 'a',
        depositAmount: 1,
        creditAmount: 0,
        excessAmount: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('H1: 정산코드 이동(owner_id != 현재 code) → 재발송 차감 BLOCK', async () => {
    fx.alloc = { id: 'a-1', walletAccountId: 'w-1' };
    fx.wallet = { id: 'w-1', ownerId: 'company-1', depositBalance: 10000, creditUsedAmount: 0, creditExcessAmount: 0 };
    fx.line = { allocationId: 'a-1', orderDeliveryId: 101 };
    fx.billingUserCode = 'company-2';
    await expect(
      sut.resendDeduct({
        orderId: 777,
        orderDeliveryId: 101,
        attemptId: 'att-1',
        depositAmount: 5000,
        creditAmount: 0,
        excessAmount: 0,
      }),
    ).rejects.toThrow(/정산코드가 변경된 계정/);
    expect(savedWalletTxs).toHaveLength(0);
  });
});
