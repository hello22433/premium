import { BadRequestException } from '@nestjs/common';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { PricingOutcome } from '../domain/partner.settle.pricing';
import { PartnerSettleReviewRecalculateService } from './partner.settle.review.recalculate.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NORMAL_PRICING: PricingOutcome = {
  status: 'NORMAL',
  pricingResolution: 'HISTORY_MATCH',
  pricePercent: 2.5,
  priceAdjustment: IPriceAdjustment.DISCOUNT,
  appliedDiscountHistoryId: 99,
};

const NEEDS_REVIEW_PRICING: PricingOutcome = {
  status: 'NEEDS_REVIEW',
  reviewCode: 'COVERAGE_GAP',
  reason: '이력 미보정',
};

function makeLedger(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    partnerCompanyId: 4,
    status: 'NEEDS_REVIEW',
    reviewCode: 'COVERAGE_GAP',
    reviewResolution: null,
    occurredAt: new Date('2026-07-15T09:00:00'),
    baseAmount: '10000',
    discountAmount: '0',
    vatCalculationMode: 'SEPARATE_ROUND',
    orderDeliveryId: 100,
    appliedPricePercent: null,
    appliedPriceAdjustment: null,
    settleAmount: null,
    pricingResolution: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function buildMocks(
  options: {
    ledger?: Record<string, unknown> | null;
    pricing?: PricingOutcome;
    opmRow?: Record<string, unknown> | null;
  } = {},
) {
  const ledgerRow = options.ledger === undefined ? makeLedger() : options.ledger;
  const pricingOutcome = options.pricing ?? NORMAL_PRICING;
  const opmRow =
    options.opmRow === undefined
      ? {
          snapshotProductPrice: 5000,
          snapshotProductCategory: '모바일쿠폰',
          snapshotProductClassificationId: null,
          snapshotProductBrandName: 'CU',
        }
      : options.opmRow;

  // QueryRunner mock
  const committed = { value: false };
  const rolledBack = { value: false };
  const released = { value: false };

  const updateCalls: Array<{ id: number; data: Record<string, unknown> }> = [];
  const insertCalls: Array<Record<string, unknown>> = [];

  // manager.getRepository() mock
  const ledgerQb = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn(async () => ledgerRow),
  };

  const opmQb = {
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn(async () => opmRow),
  };

  const managerMock = {
    queryRunner: { isTransactionActive: true },
    getRepository: jest.fn((entity: { name: string }) => {
      if (entity.name === 'PartnerSettleLedgerEntity') {
        return {
          createQueryBuilder: () => ledgerQb,
          update: jest.fn(async (id: number, data: Record<string, unknown>) => {
            updateCalls.push({ id, data });
          }),
        };
      }
      if (entity.name === 'OrderProductMappingEntity') {
        return {
          createQueryBuilder: () => opmQb,
        };
      }
      if (entity.name === 'PartnerSettleReviewAuditEntity') {
        return {
          insert: jest.fn(async (data: Record<string, unknown>) => {
            insertCalls.push(data);
          }),
        };
      }
      return {};
    }),
  };

  const qr = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(async () => {
      committed.value = true;
    }),
    rollbackTransaction: jest.fn(async () => {
      rolledBack.value = true;
    }),
    release: jest.fn(async () => {
      released.value = true;
    }),
    manager: managerMock,
  };

  const dataSource = {
    createQueryRunner: () => qr,
  };

  const pricingResolver = {
    lockPolicyForRead: jest.fn().mockResolvedValue(undefined),
    resolveAt: jest.fn().mockResolvedValue(pricingOutcome),
  };

  // The service uses @InjectRepository but we override the DataSource path
  const service = new PartnerSettleReviewRecalculateService(
    {} as never, // ledgerRepository — only used by resolveLedgerIds (partnerCompanyId path)
    {} as never, // opmRepository — unused (manager.getRepository path)
    {} as never, // auditRepository — unused (manager.getRepository path)
    pricingResolver as never,
    dataSource as never,
  );

  return { service, qr, pricingResolver, committed, rolledBack, released, updateCalls, insertCalls, managerMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PartnerSettleReviewRecalculateService', () => {
  describe('성공 (COVERAGE_GAP → NORMAL)', () => {
    it('lockPolicyForRead → resolveAt → UPDATE → audit INSERT → commit', async () => {
      const { service, pricingResolver, committed, rolledBack, updateCalls, insertCalls, managerMock } = buildMocks();

      const result = await service.recalculate({ ledgerIds: [1] }, 42);

      expect(result.succeeded).toHaveLength(1);
      expect(result.succeeded[0]).toEqual({ ledgerId: 1, status: 'NORMAL' });
      expect(result.failed).toHaveLength(0);

      // P1 핵심: lockPolicyForRead 가 manager 와 함께 호출됨
      expect(pricingResolver.lockPolicyForRead).toHaveBeenCalledWith(4, managerMock);

      // P1 핵심: resolveAt 에 manager 전달됨
      expect(pricingResolver.resolveAt).toHaveBeenCalledWith(
        4,
        expect.any(Date),
        expect.objectContaining({ price: 5000 }),
        managerMock,
      );

      // ledger UPDATE 확인
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].data.status).toBe('NORMAL');
      expect(updateCalls[0].data.reviewCode).toBeNull();
      expect(updateCalls[0].data.appliedPricePercent).toBe('2.5');
      expect(updateCalls[0].data.appliedPriceAdjustment).toBe(IPriceAdjustment.DISCOUNT);

      // audit INSERT 확인
      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0].beforeStatus).toBe('NEEDS_REVIEW');
      expect(insertCalls[0].afterStatus).toBe('NORMAL');
      expect(insertCalls[0].actorId).toBe(42);

      expect(committed.value).toBe(true);
      expect(rolledBack.value).toBe(false);
    });

    it('POLICY_CONFLICT 도 deterministic 대상', async () => {
      const { service } = buildMocks({ ledger: makeLedger({ reviewCode: 'POLICY_CONFLICT' }) });
      const result = await service.recalculate({ ledgerIds: [1] }, 42);
      expect(result.succeeded).toHaveLength(1);
    });
  });

  describe('여전히 NEEDS_REVIEW (이력 미보정)', () => {
    it('resolveAt 이 NEEDS_REVIEW 이면 VALIDATION_FAILED + rollback', async () => {
      const { service, committed, rolledBack } = buildMocks({ pricing: NEEDS_REVIEW_PRICING });

      const result = await service.recalculate({ ledgerIds: [1] }, 42);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toEqual({ ledgerId: 1, code: 'VALIDATION_FAILED' });
      expect(result.succeeded).toHaveLength(0);

      expect(rolledBack.value).toBe(true);
      expect(committed.value).toBe(false);
    });
  });

  describe('대상 아닌 ledger 거부', () => {
    it('NOT_FOUND — 존재하지 않는 ledgerId', async () => {
      const { service, rolledBack } = buildMocks({ ledger: null });
      const result = await service.recalculate({ ledgerIds: [999] }, 42);
      expect(result.failed[0]).toEqual({ ledgerId: 999, code: 'NOT_FOUND' });
      expect(rolledBack.value).toBe(true);
    });

    it('ALREADY_RESOLVED — status 가 NEEDS_REVIEW 가 아닌 경우', async () => {
      const { service } = buildMocks({ ledger: makeLedger({ status: 'NORMAL' }) });
      const result = await service.recalculate({ ledgerIds: [1] }, 42);
      expect(result.failed[0]).toEqual({ ledgerId: 1, code: 'ALREADY_RESOLVED' });
    });

    it('NOT_DETERMINISTIC — UNKNOWN 등 수동 해소 대상', async () => {
      const { service } = buildMocks({ ledger: makeLedger({ reviewCode: 'UNKNOWN' }) });
      const result = await service.recalculate({ ledgerIds: [1] }, 42);
      expect(result.failed[0]).toEqual({ ledgerId: 1, code: 'NOT_DETERMINISTIC' });
    });

    it('VALIDATION_FAILED — occurredAt 이 null', async () => {
      const { service } = buildMocks({ ledger: makeLedger({ occurredAt: null }) });
      const result = await service.recalculate({ ledgerIds: [1] }, 42);
      expect(result.failed[0]).toEqual({ ledgerId: 1, code: 'VALIDATION_FAILED' });
    });

    it('VALIDATION_FAILED — baseAmount 이 null', async () => {
      const { service } = buildMocks({ ledger: makeLedger({ baseAmount: null }) });
      const result = await service.recalculate({ ledgerIds: [1] }, 42);
      expect(result.failed[0]).toEqual({ ledgerId: 1, code: 'VALIDATION_FAILED' });
    });

    it('VALIDATION_FAILED — OPM 이 없는 경우', async () => {
      const { service } = buildMocks({ opmRow: null });
      const result = await service.recalculate({ ledgerIds: [1] }, 42);
      expect(result.failed[0]).toEqual({ ledgerId: 1, code: 'VALIDATION_FAILED' });
    });
  });

  describe('배치 상한', () => {
    it('MAX_RECALC_BATCH(200) 초과 시 BadRequestException', async () => {
      const ids = Array.from({ length: 201 }, (_, i) => i + 1);
      const { service } = buildMocks();
      await expect(service.recalculate({ ledgerIds: ids }, 42)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('트랜잭션 롤백 — 예외 발생 시', () => {
    it('recalculateOne 내부 throw 시 rollback + VALIDATION_FAILED 반환', async () => {
      const { service, pricingResolver, rolledBack, released } = buildMocks();
      pricingResolver.lockPolicyForRead.mockRejectedValueOnce(new Error('lock fail'));

      const result = await service.recalculate({ ledgerIds: [1] }, 42);

      expect(result.failed).toHaveLength(1);
      expect((result.failed[0] as { code: string }).code).toBe('VALIDATION_FAILED');
      expect(rolledBack.value).toBe(true);
      expect(released.value).toBe(true);
    });
  });

  describe('금액 계산 정확성', () => {
    it('DISCOUNT 10% — settleAmount 89000, 수수료 10000, VAT 1000', async () => {
      // baseAmount=100000, discount=0, pricePercent=10, DISCOUNT, SEPARATE_ROUND
      // commission = truncate(100000 × 100000 / 1000000) = 10000
      // vat = roundHalfUp(10000 / 10) = 1000
      // feeTotal = 10000 + 1000 = 11000
      // settleAmount = 100000 - 0 - 11000 = 89000
      const { service, updateCalls } = buildMocks({
        ledger: makeLedger({ baseAmount: '100000', discountAmount: '0' }),
        pricing: {
          status: 'NORMAL' as const,
          pricingResolution: 'HISTORY_MATCH' as const,
          pricePercent: 10,
          priceAdjustment: IPriceAdjustment.DISCOUNT,
          appliedDiscountHistoryId: 5,
        },
      });

      await service.recalculate({ ledgerIds: [1] }, 42);

      expect(updateCalls).toHaveLength(1);
      const d = updateCalls[0].data;
      expect(d.appliedPricePercent).toBe('10');
      expect(d.settleAmount).toBe('89000');
      expect(d.givingCommissionAmount).toBe('10000');
      expect(d.receivingCommissionAmount).toBe('0');
      expect(d.vatAmount).toBe('1000');
      expect(d.feeTotalAmount).toBe('11000');
    });

    it('ADDITIONAL 10% — settleAmount 111000 (매입가산)', async () => {
      // ADDITIONAL: receiving = 10000, netCommission = -10000
      // vat = -1000, feeTotal = -11000
      // settleAmount = 100000 - 0 - (-11000) = 111000
      const { service, updateCalls } = buildMocks({
        ledger: makeLedger({ baseAmount: '100000', discountAmount: '0' }),
        pricing: {
          status: 'NORMAL' as const,
          pricingResolution: 'HISTORY_MATCH' as const,
          pricePercent: 10,
          priceAdjustment: IPriceAdjustment.ADDITIONAL,
          appliedDiscountHistoryId: 5,
        },
      });

      await service.recalculate({ ledgerIds: [1] }, 42);

      expect(updateCalls).toHaveLength(1);
      const d = updateCalls[0].data;
      expect(d.settleAmount).toBe('111000');
      expect(d.givingCommissionAmount).toBe('0');
      expect(d.receivingCommissionAmount).toBe('10000');
      expect(d.vatAmount).toBe('-1000');
      expect(d.feeTotalAmount).toBe('-11000');
    });

    it('DISCOUNT 7.5% — 반올림 검증 (VAT 750)', async () => {
      // commission = truncate(100000 × 75000 / 1000000) = 7500
      // vat SEPARATE_ROUND = roundHalfUp(7500 / 10) = 750
      // feeTotal = 7500 + 750 = 8250
      // settleAmount = 100000 - 0 - 8250 = 91750
      const { service, updateCalls } = buildMocks({
        ledger: makeLedger({ baseAmount: '100000', discountAmount: '0' }),
        pricing: {
          status: 'NORMAL' as const,
          pricingResolution: 'HISTORY_MATCH' as const,
          pricePercent: 7.5,
          priceAdjustment: IPriceAdjustment.DISCOUNT,
          appliedDiscountHistoryId: 5,
        },
      });

      await service.recalculate({ ledgerIds: [1] }, 42);

      expect(updateCalls).toHaveLength(1);
      const d = updateCalls[0].data;
      expect(d.settleAmount).toBe('91750');
      expect(d.givingCommissionAmount).toBe('7500');
      expect(d.vatAmount).toBe('750');
      expect(d.feeTotalAmount).toBe('8250');
    });
  });

  describe('부분 성공 (복수 ledger)', () => {
    it('1건 성공 + 1건 실패 혼합 결과', async () => {
      // 별도 buildMocks 로 두 번째 호출에서 NOT_FOUND 되도록 구성
      let callCount = 0;
      const ledgerRow = makeLedger();

      const updateCalls: Array<{ id: number; data: Record<string, unknown> }> = [];
      const insertCalls: Array<Record<string, unknown>> = [];
      const opmRow = {
        snapshotProductPrice: 5000,
        snapshotProductCategory: '모바일쿠폰',
        snapshotProductClassificationId: null,
        snapshotProductBrandName: 'CU',
      };

      const ledgerQbFactory = () => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => {
          callCount++;
          return callCount <= 1 ? ledgerRow : null;
        }),
      });

      const opmQb = { where: jest.fn().mockReturnThis(), getOne: jest.fn(async () => opmRow) };

      const managerMock = {
        queryRunner: { isTransactionActive: true },
        getRepository: jest.fn((entity: { name: string }) => {
          if (entity.name === 'PartnerSettleLedgerEntity') {
            return {
              createQueryBuilder: ledgerQbFactory,
              update: jest.fn(async (id: number, data: Record<string, unknown>) => {
                updateCalls.push({ id, data });
              }),
            };
          }
          if (entity.name === 'OrderProductMappingEntity') return { createQueryBuilder: () => opmQb };
          if (entity.name === 'PartnerSettleReviewAuditEntity') {
            return {
              insert: jest.fn(async (data: Record<string, unknown>) => {
                insertCalls.push(data);
              }),
            };
          }
          return {};
        }),
      };

      const qr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: managerMock,
      };

      const pricingResolver = {
        lockPolicyForRead: jest.fn().mockResolvedValue(undefined),
        resolveAt: jest.fn().mockResolvedValue(NORMAL_PRICING),
      };

      const service = new PartnerSettleReviewRecalculateService(
        {} as never,
        {} as never,
        {} as never,
        pricingResolver as never,
        { createQueryRunner: () => qr } as never,
      );

      const result = await service.recalculate({ ledgerIds: [1, 2] }, 42);

      expect(result.succeeded).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toEqual({ ledgerId: 2, code: 'NOT_FOUND' });
    });
  });
});
