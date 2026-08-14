import { ConflictException } from '@nestjs/common';
import { PartnerSettleRepriceService } from './partner.settle.reprice.service';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';

// ─── Mock infrastructure ───

function makeQueryBuilder(overrides: Record<string, unknown> = {}) {
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  return qb;
}

function makeRepo(overrides: Record<string, any> = {}) {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => makeQueryBuilder()),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    ...overrides,
  };
}

function makeManager(repos: Record<string, any> = {}) {
  return {
    query: jest.fn().mockResolvedValue([]),
    getRepository: jest.fn((entity: any) => {
      const name = typeof entity === 'function' ? entity.name : entity;
      return repos[name] ?? makeRepo();
    }),
  } as any;
}

function makeLedger(overrides: Record<string, any> = {}): PartnerSettleLedgerEntity {
  return {
    id: 100,
    partnerCompanyId: 7,
    subItemKey: 'NONE',
    sourceType: 'ISSUANCE',
    orderDeliveryId: 200,
    occurredAt: new Date('2026-08-01'),
    baseAmount: '10000',
    discountAmount: '0',
    settleAmount: '9500',
    vatCalculationMode: 'NONE',
    appliedPricePercent: '5',
    appliedPriceAdjustment: IPriceAdjustment.DISCOUNT,
    appliedDiscountHistoryId: 10,
    pricingResolution: 'HISTORY_MATCH',
    reversesLedgerId: null,
    status: 'NORMAL',
    settleBatchId: null,
    ...overrides,
  } as PartnerSettleLedgerEntity;
}

describe('PartnerSettleRepriceService', () => {
  let service: PartnerSettleRepriceService;
  let ledgerRepo: any;
  let opmRepo: any;
  let mgr: any;
  let pricingResolver: any;
  let proposalService: any;

  beforeEach(() => {
    ledgerRepo = makeRepo();
    opmRepo = makeRepo();

    mgr = makeManager({
      PartnerSettleLedgerEntity: ledgerRepo,
      OrderProductMappingEntity: opmRepo,
    });

    pricingResolver = {
      resolveAt: jest.fn().mockResolvedValue({
        status: 'RESOLVED',
        pricePercent: 3,
        priceAdjustment: IPriceAdjustment.DISCOUNT,
        appliedDiscountHistoryId: 20,
        pricingResolution: 'HISTORY_MATCH',
      }),
    };

    proposalService = {
      createRepriceProposals: jest.fn().mockResolvedValue([]),
    };


    service = new PartnerSettleRepriceService(
      {} as any, // dataSource — unused in repriceForReservation
      pricingResolver,
      proposalService,
    );
  });


  // ─── candidate 조회 ───

  describe('candidate 조회', () => {
    it('candidate 없으면 0/0', async () => {
      ledgerRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getMany: jest.fn().mockResolvedValue([]) }),
      );

      const result = await service.repriceForReservation(
        { partnerCompanyId: 7, effectiveAt: new Date('2026-07-01') },
        1,
        mgr,
      );
      expect(result).toEqual({ directCount: 0, proposalCount: 0 });
    });

    it('pricing 변경 없는 candidate → skip', async () => {
      const candidate = makeLedger();
      ledgerRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getMany: jest.fn().mockResolvedValue([candidate]) }),
      );

      // pricing 동일 (5% DISCOUNT)
      pricingResolver.resolveAt.mockResolvedValue({
        status: 'RESOLVED',
        pricePercent: 5,
        priceAdjustment: IPriceAdjustment.DISCOUNT,
        appliedDiscountHistoryId: 10,
        pricingResolution: 'HISTORY_MATCH',
      });

      const result = await service.repriceForReservation(
        { partnerCompanyId: 7, effectiveAt: new Date('2026-07-01') },
        1,
        mgr,
      );
      expect(result).toEqual({ directCount: 0, proposalCount: 0 });
    });
  });

  // ─── DIRECT 분기 ───

  describe('DIRECT 분기', () => {
    function setupDirectCandidate() {
      const candidate = makeLedger({ id: 100 });

      // findCandidates
      let candidateQbCalled = false;
      ledgerRepo.createQueryBuilder.mockImplementation(() => {
        if (!candidateQbCalled) {
          candidateQbCalled = true;
          return makeQueryBuilder({ getMany: jest.fn().mockResolvedValue([candidate]) });
        }
        // loadAllReversals, then lock graph
        return makeQueryBuilder({
          getMany: jest.fn().mockResolvedValue([candidate]),
          getOne: jest.fn().mockResolvedValue(candidate),
        });
      });

      // batch release = empty → DIRECT
      mgr.query.mockResolvedValue([]);

      return candidate;
    }

    it('DIRECT → ledger UPDATE 호출', async () => {
      setupDirectCandidate();

      const result = await service.repriceForReservation(
        { partnerCompanyId: 7, effectiveAt: new Date('2026-07-01') },
        1,
        mgr,
      );
      expect(result.directCount).toBeGreaterThan(0);
      expect(result.proposalCount).toBe(0);
      expect(ledgerRepo.update).toHaveBeenCalled();
    });
  });

  // ─── PROPOSAL 분기 ───

  describe('PROPOSAL 분기', () => {
    function setupProposalCandidate() {
      const candidate = makeLedger({ id: 100, settleBatchId: 5 });

      let candidateQbCalled = false;
      ledgerRepo.createQueryBuilder.mockImplementation(() => {
        if (!candidateQbCalled) {
          candidateQbCalled = true;
          return makeQueryBuilder({ getMany: jest.fn().mockResolvedValue([candidate]) });
        }
        return makeQueryBuilder({
          getMany: jest.fn().mockResolvedValue([candidate]),
          getOne: jest.fn().mockResolvedValue(candidate),
        });
      });

      mgr.query
        .mockResolvedValueOnce([]) // loadAllReversals — no batch release rows
        .mockResolvedValue([]); // loadApprovedAdjustmentSums
    }

    it('PROPOSAL → createRepriceProposals 호출', async () => {
      setupProposalCandidate();

      const result = await service.repriceForReservation(
        { partnerCompanyId: 7, effectiveAt: new Date('2026-07-01') },
        1,
        mgr,
      );
      expect(result.proposalCount).toBeGreaterThan(0);
      expect(result.directCount).toBe(0);
      expect(proposalService.createRepriceProposals).toHaveBeenCalledWith(
        expect.objectContaining({ partnerCompanyId: 7, rootLedger: expect.any(Object) }),
        mgr,
      );
    });
  });

  // ─── NEEDS_REVIEW 예외 ───

  describe('NEEDS_REVIEW 예외', () => {
    it('resolveAt NEEDS_REVIEW → 트랜잭션 롤백 Error', async () => {
      const candidate = makeLedger({ id: 100 });
      ledgerRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getMany: jest.fn().mockResolvedValue([candidate]) }),
      );

      pricingResolver.resolveAt.mockResolvedValue({
        status: 'NEEDS_REVIEW',
        pricePercent: 0,
        priceAdjustment: IPriceAdjustment.DISCOUNT,
        appliedDiscountHistoryId: null,
        pricingResolution: 'HISTORY_MATCH',
      });

      await expect(
        service.repriceForReservation(
          { partnerCompanyId: 7, effectiveAt: new Date('2026-07-01') },
          1,
          mgr,
        ),
      ).rejects.toThrow(/NEEDS_REVIEW/);
    });
  });

  // ─── snapshot 로딩 ───

  describe('snapshot 로딩', () => {
    it('orderDeliveryId null → 빈 snapshot', async () => {
      const candidate = makeLedger({ id: 100, orderDeliveryId: null });

      let callIdx = 0;
      ledgerRepo.createQueryBuilder.mockImplementation(() => {
        callIdx++;
        if (callIdx === 1) {
          return makeQueryBuilder({ getMany: jest.fn().mockResolvedValue([candidate]) });
        }
        return makeQueryBuilder({
          getMany: jest.fn().mockResolvedValue([candidate]),
          getOne: jest.fn().mockResolvedValue(candidate),
        });
      });
      mgr.query.mockResolvedValue([]);

      const result = await service.repriceForReservation(
        { partnerCompanyId: 7, effectiveAt: new Date('2026-07-01') },
        1,
        mgr,
      );
      expect(pricingResolver.resolveAt).toHaveBeenCalledWith(
        7,
        expect.any(Date),
        expect.objectContaining({ price: null }),
        mgr,
      );
    });

    it('OPM 없으면 → 빈 snapshot', async () => {
      const candidate = makeLedger({ id: 100, orderDeliveryId: 200 });

      let callIdx = 0;
      ledgerRepo.createQueryBuilder.mockImplementation(() => {
        callIdx++;
        if (callIdx === 1) {
          return makeQueryBuilder({ getMany: jest.fn().mockResolvedValue([candidate]) });
        }
        return makeQueryBuilder({
          getMany: jest.fn().mockResolvedValue([candidate]),
          getOne: jest.fn().mockResolvedValue(candidate),
        });
      });
      opmRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOne: jest.fn().mockResolvedValue(null) }),
      );
      mgr.query.mockResolvedValue([]);

      await service.repriceForReservation(
        { partnerCompanyId: 7, effectiveAt: new Date('2026-07-01') },
        1,
        mgr,
      );
      expect(pricingResolver.resolveAt).toHaveBeenCalledWith(
        7,
        expect.any(Date),
        expect.objectContaining({ price: null }),
        mgr,
      );
    });
  });
});
