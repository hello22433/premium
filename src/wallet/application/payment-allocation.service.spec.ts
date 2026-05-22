import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PaymentAllocationService, AllocationInput } from './payment-allocation.service';
import { WalletResourceType } from '../interface/wallet-resource-type';

const baseInput = (overrides: Partial<AllocationInput> = {}): AllocationInput => ({
  orderId: 1,
  walletAccountId: '1',
  lines: [
    {
      orderProductMappingId: 1,
      orderDeliveryId: 100,
      orderType: 'GENERAL',
      grossSettlementAmount: 10000,
      pointPolicyEffect: 'ALLOW',
    },
  ],
  cardSurchargeApplied: false,
  requestedPointAmount: 0,
  requestedDepositAmount: null,
  availableDeposit: 0,
  creditLimit: 100000,
  creditUsedAmountBefore: 0,
  isPrePayment: false,
  ...overrides,
});

describe('PaymentAllocationService', () => {
  let sut: PaymentAllocationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentAllocationService],
    }).compile();
    sut = module.get(PaymentAllocationService);
  });

  it('mutex 위반 (카드할증 + 할인 동시) → BadRequestException', () => {
    expect(() =>
      sut.allocate(
        baseInput({
          cardSurchargeApplied: true,
          lines: [
            {
              orderProductMappingId: 1,
              orderDeliveryId: 100,
              orderType: 'GENERAL',
              grossSettlementAmount: 10000,
              appliedPriceAdjustment: 'DISCOUNT',
              pointPolicyEffect: 'ALLOW',
            },
          ],
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('선정산 + 예치금 충분 → 전액 예치금', () => {
    const r = sut.allocate(baseInput({ isPrePayment: true, availableDeposit: 50000 }));
    expect(r.depositUsedAmount).toBe(10000);
    expect(r.creditUsedAmount).toBe(0);
    expect(r.creditExcessAmount).toBe(0);
  });

  it('후정산 default → 여신 사용 (예치금 0)', () => {
    const r = sut.allocate(baseInput({ isPrePayment: false }));
    expect(r.depositUsedAmount).toBe(0);
    expect(r.creditUsedAmount).toBe(10000);
    expect(r.creditExcessAmount).toBe(0);
  });

  it('후정산 + depositUseAmount 지정 + 나머지 여신', () => {
    const r = sut.allocate(
      baseInput({
        isPrePayment: false,
        availableDeposit: 100000,
        requestedDepositAmount: 3000,
      }),
    );
    expect(r.depositUsedAmount).toBe(3000);
    expect(r.creditUsedAmount).toBe(7000);
  });

  it('여신 한도 초과 → 신용초과', () => {
    const r = sut.allocate(baseInput({ creditLimit: 5000, creditUsedAmountBefore: 0 }));
    expect(r.creditUsedAmount).toBe(5000);
    expect(r.creditExcessAmount).toBe(5000);
  });

  it('포인트 사용 → payable 차감 후 카드할증', () => {
    const r = sut.allocate(
      baseInput({
        cardSurchargeApplied: true,
        availableDeposit: 100000,
        isPrePayment: true,
        requestedPointAmount: 3000,
        grants: [{ pointGrantId: '1', remainingAmount: 5000, expiresAt: null }],
      }),
    );
    expect(r.pointUsedAmount).toBe(3000);
    expect(r.cardSurchargeBase).toBe(7000);
    expect(r.cardSurchargeAmount).toBeGreaterThan(0);
  });

  it('포인트 DENY 라인은 포인트 사용 안 함', () => {
    const r = sut.allocate(
      baseInput({
        availableDeposit: 100000,
        isPrePayment: true,
        requestedPointAmount: 5000,
        lines: [
          {
            orderProductMappingId: 1,
            orderType: 'SSG',
            grossSettlementAmount: 10000,
            pointPolicyEffect: 'DENY',
          },
        ],
      }),
    );
    expect(r.pointUsedAmount).toBe(0);
  });

  it('resourceBreakdown 합 = payable + point', () => {
    const r = sut.allocate(
      baseInput({
        availableDeposit: 5000,
        isPrePayment: true,
        requestedDepositAmount: 5000,
        requestedPointAmount: 1000,
        creditLimit: 100000,
        grants: [{ pointGrantId: '1', remainingAmount: 2000, expiresAt: null }],
      }),
    );
    const sum =
      r.resourceBreakdown[WalletResourceType.POINT] +
      r.resourceBreakdown[WalletResourceType.DEPOSIT] +
      r.resourceBreakdown[WalletResourceType.CREDIT] +
      r.resourceBreakdown[WalletResourceType.CREDIT_EXCESS];
    expect(sum).toBe(r.pointUsedAmount + r.payableSettlementAmount);
  });

  it('포인트 사용액 > 0 + grants 누락 → fail-closed (drift guard)', () => {
    expect(() =>
      sut.allocate(
        baseInput({
          availableDeposit: 100000,
          isPrePayment: true,
          requestedPointAmount: 1000,
          // grants 미지정
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('동일 만료일 grants → FIFO id 숫자 비교 ("10" > "2")', () => {
    const r = sut.allocate(
      baseInput({
        availableDeposit: 100000,
        isPrePayment: true,
        requestedPointAmount: 1500,
        grants: [
          { pointGrantId: '10', remainingAmount: 5000, expiresAt: null },
          { pointGrantId: '2', remainingAmount: 5000, expiresAt: null },
        ],
      }),
    );
    expect(r.pointUsages[0].pointGrantId).toBe('2');
  });

  it('applyCardSurcharge: 카드할증 적용 시 10원 절사 식', () => {
    expect(sut.applyCardSurcharge(10000, false)).toBe(10000);
    expect(sut.applyCardSurcharge(10000, true)).toBe(Math.floor((10000 + Math.round(10000 * 0.03)) / 10) * 10);
  });
});
