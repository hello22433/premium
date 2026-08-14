import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  PartnerSettleAdjustmentProposalService,
  AdjustmentActor,
} from './partner.settle.adjustment.proposal.service';

// ─── Mock infrastructure ───

function makeQueryBuilder(overrides: Record<string, unknown> = {}) {
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    getOneOrFail: jest.fn().mockResolvedValue({ id: 1 }),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  return qb;
}

type RepoMock = {
  findOne: jest.Mock;
  findOneOrFail: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(overrides: Partial<RepoMock> = {}): RepoMock {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    findOneOrFail: jest.fn().mockResolvedValue({ id: 1 }),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (entity: any) => ({ id: 1, ...entity })),
    createQueryBuilder: jest.fn(() => makeQueryBuilder()),
    ...overrides,
  };
}

function makeManager(repos: Record<string, any> = {}) {
  const manager: any = {
    query: jest.fn().mockResolvedValue([{ now6: '2026-08-10 12:00:00.000000' }]),
    createQueryBuilder: jest.fn(() => makeQueryBuilder()),
    getRepository: jest.fn((entity: any) => {
      const name = typeof entity === 'function' ? entity.name : entity;
      return repos[name] ?? makeRepo();
    }),
  };
  return manager;
}

function makeQueryRunner(manager: any) {
  return {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager,
  };
}

function makeDataSource(repos: Record<string, any> = {}, manager?: any) {
  const mgr = manager ?? makeManager(repos);
  const qr = makeQueryRunner(mgr);
  return {
    ds: {
      manager: mgr,
      getRepository: jest.fn((entity: any) => {
        const name = typeof entity === 'function' ? entity.name : entity;
        return repos[name] ?? makeRepo();
      }),
      createQueryRunner: jest.fn(() => qr),
    } as any,
    qr,
    mgr,
  };
}

// ─── Helpers ───

const ACTOR: AdjustmentActor = { id: 10, email: 'test@test.com' };
const OTHER_ACTOR: AdjustmentActor = { id: 20, email: 'other@test.com' };

function makeProposal(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    partnerCompanyId: 7,
    subItemKey: 'NONE',
    sourceLedgerId: 100,
    discountChangeId: null,
    proposedAmount: '200',
    reason: 'test',
    status: 'PENDING',
    createdBy: 10,
    requestKey: 'req-1',
    payloadHash: 'v1:abc',
    payloadHashVersion: 'v1',
    resolutionGroupKey: null,
    decidedBy: null,
    decidedAt: null,
    approvedAmount: null,
    resultLedgerId: null,
    amountOverrideReason: null,
    decisionReason: null,
    ...overrides,
  };
}

function makeLedger(overrides: Record<string, any> = {}) {
  return {
    id: 100,
    partnerCompanyId: 7,
    subItemKey: 'NONE',
    baseAmount: '10000',
    settleAmount: '9500',
    discountAmount: '0',
    occurredAt: new Date('2026-08-01'),
    vatCalculationMode: 'NONE',
    reversesLedgerId: null,
    status: 'NORMAL',
    orderDeliveryId: null,
    ...overrides,
  };
}

describe('PartnerSettleAdjustmentProposalService', () => {
  let service: PartnerSettleAdjustmentProposalService;
  let proposalRepo: RepoMock;
  let ledgerRepo: RepoMock;
  let companyRepo: RepoMock;
  let qr: any;
  let mgr: any;
  let ledgerService: any;
  let pricingResolver: any;

  beforeEach(() => {
    proposalRepo = makeRepo();
    ledgerRepo = makeRepo();
    companyRepo = makeRepo();

    const repos: Record<string, any> = {
      PartnerSettleAdjustmentProposalEntity: proposalRepo,
      PartnerSettleLedgerEntity: ledgerRepo,
      PartnerCompanyEntity: companyRepo,
      OrderProductMappingEntity: makeRepo(),
    };

    const { ds, qr: queryRunner, mgr: manager } = makeDataSource(repos);
    qr = queryRunner;
    mgr = manager;

    ledgerService = {
      appendAdjustmentLedger: jest.fn().mockResolvedValue({ id: 500 }),
    };
    pricingResolver = {
      resolveAt: jest.fn().mockResolvedValue({
        status: 'RESOLVED',
        pricePercent: 5,
        priceAdjustment: 'DISCOUNT',
        appliedDiscountHistoryId: 10,
        pricingResolution: 'HISTORY_MATCH',
      }),
    };

    service = new PartnerSettleAdjustmentProposalService(ds, ledgerService, pricingResolver);
  });

  // ─── createManual ───

  describe('createManual', () => {
    it('새 proposal 생성', async () => {
      const dto = {
        partnerCompanyId: 7,
        subItemKey: 'NONE',
        amount: '200',
        reason: 'test',
        requestKey: 'req-1',
      };

      const saved = makeProposal({ id: 1, requestKey: 'req-1' });
      proposalRepo.save.mockResolvedValue(saved);

      const result = await service.createManual(dto, ACTOR, mgr);
      expect(result.id).toBe(1);
      expect(proposalRepo.save).toHaveBeenCalled();
    });

    it('동일 requestKey·동일 payload → 기존 반환 (멱등)', async () => {
      const existing = makeProposal({ id: 5 });
      proposalRepo.findOne.mockResolvedValue(existing);

      // computePayloadHash 를 맞추기 위해 existing 의 hash 를 실제 계산값으로 설정
      const { computePayloadHash } = jest.requireActual('../domain/proposal.hash') as any;
      const dto = {
        partnerCompanyId: 7,
        subItemKey: 'NONE',
        amount: '200',
        reason: 'test',
        requestKey: 'req-1',
      };
      existing.payloadHash = computePayloadHash(
        { partnerCompanyId: 7, subItemKey: 'NONE', sourceLedgerId: null, amount: '200', reason: 'test' },
        'v1',
      );

      const result = await service.createManual(dto, ACTOR, mgr);
      expect(result.id).toBe(5);
      expect(proposalRepo.save).not.toHaveBeenCalled();
    });

    it('동일 requestKey·다른 payload → ConflictException', async () => {
      proposalRepo.findOne.mockResolvedValue(makeProposal({ payloadHash: 'v1:different' }));

      const dto = {
        partnerCompanyId: 7,
        subItemKey: 'NONE',
        amount: '200',
        reason: 'test',
        requestKey: 'req-1',
      };

      await expect(service.createManual(dto, ACTOR, mgr)).rejects.toBeInstanceOf(ConflictException);
    });

    it('source ledger partnerCompanyId 불일치 → BadRequestException', async () => {
      const ledger = makeLedger({ partnerCompanyId: 99 });
      ledgerRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOne: jest.fn().mockResolvedValue(ledger) }),
      );

      const dto = {
        partnerCompanyId: 7,
        subItemKey: 'NONE',
        sourceLedgerId: 100,
        amount: '200',
        reason: 'test',
        requestKey: 'req-2',
      };

      await expect(service.createManual(dto, ACTOR, mgr)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('source ledger 없음 → NotFoundException', async () => {
      ledgerRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOne: jest.fn().mockResolvedValue(null) }),
      );

      await expect(service.createManual({
        partnerCompanyId: 7,
        subItemKey: 'NONE',
        sourceLedgerId: 999,
        amount: '200',
        reason: 'test',
        requestKey: 'req-missing-source',
      }, ACTOR, mgr)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ER_DUP_ENTRY 후 재조회로 기존 proposal 반환 (동시 요청 수렴)', async () => {
      const dto = {
        partnerCompanyId: 7,
        subItemKey: 'NONE',
        amount: '200',
        reason: 'test',
        requestKey: 'req-dup',
      };

      const { computePayloadHash: realHash } = jest.requireActual('../domain/proposal.hash') as any;
      const hash = realHash(
        { partnerCompanyId: 7, subItemKey: 'NONE', sourceLedgerId: null, amount: '200', reason: 'test' },
        'v1',
      );
      const existingProposal = makeProposal({ id: 77, requestKey: 'req-dup', payloadHash: hash });

      // No manager → uses transaction path
      // First findOne returns null (race), save throws ER_DUP_ENTRY
      const dupError: any = new Error('Duplicate entry');
      dupError.code = 'ER_DUP_ENTRY';

      // In-transaction repo: findOne=null, save=throw
      const txProposalRepo = makeRepo({
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockRejectedValue(dupError),
      });
      const txRepos: Record<string, any> = {
        PartnerSettleAdjustmentProposalEntity: txProposalRepo,
        PartnerSettleLedgerEntity: ledgerRepo,
        PartnerCompanyEntity: companyRepo,
        OrderProductMappingEntity: makeRepo(),
      };
      const txMgr = makeManager(txRepos);
      const txQr = makeQueryRunner(txMgr);

      // Post-rollback dataSource.getRepository re-lookup returns existing
      const dsProposalRepo = makeRepo({
        findOne: jest.fn().mockResolvedValue(existingProposal),
      });
      const ds = {
        manager: txMgr,
        getRepository: jest.fn((entity: any) => {
          const name = typeof entity === 'function' ? entity.name : entity;
          if (name === 'PartnerSettleAdjustmentProposalEntity') return dsProposalRepo;
          return makeRepo();
        }),
        createQueryRunner: jest.fn(() => txQr),
      } as any;

      const svc = new PartnerSettleAdjustmentProposalService(ds, ledgerService, pricingResolver);
      const result = await svc.createManual(dto, ACTOR);
      expect(result.id).toBe(77);
      expect(txQr.rollbackTransaction).toHaveBeenCalled();
    });

    it('source ledger status NEEDS_REVIEW → BadRequestException', async () => {
      const ledger = makeLedger({ status: 'NEEDS_REVIEW' });
      ledgerRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOne: jest.fn().mockResolvedValue(ledger) }),
      );

      const dto = {
        partnerCompanyId: 7,
        subItemKey: 'NONE',
        sourceLedgerId: 100,
        amount: '200',
        reason: 'test',
        requestKey: 'req-3',
      };

      await expect(service.createManual(dto, ACTOR, mgr)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── approve (single) ───

  describe('approve (single)', () => {
    beforeEach(() => {
      // preview lookup
      proposalRepo.findOne.mockResolvedValue(makeProposal({ resolutionGroupKey: null }));
      // locked proposal via lockSingleScope
      proposalRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({
          getOne: jest.fn().mockResolvedValue(makeProposal({ resolutionGroupKey: null })),
        }),
      );
      // company lock
      companyRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOneOrFail: jest.fn().mockResolvedValue({ id: 7 }) }),
      );
      // source ledger lock
      ledgerRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOne: jest.fn().mockResolvedValue(makeLedger()) }),
      );
      // post-commit reload
      proposalRepo.findOne
        .mockResolvedValueOnce(makeProposal({ resolutionGroupKey: null }))  // preview
        ;
      // sum query
      mgr.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({
          select: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
        }),
      );
    });

    it('PENDING → APPROVED 정상', async () => {
      const result = await service.approve(1, {}, OTHER_ACTOR);
      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(mgr.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'APPROVED'"),
        expect.any(Array),
      );
    });

    it('이미 APPROVED → idempotent 반환', async () => {
      proposalRepo.findOne.mockResolvedValue(makeProposal({ resolutionGroupKey: null }));
      proposalRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({
          getOne: jest.fn().mockResolvedValue(
            makeProposal({ status: 'APPROVED', resultLedgerId: 500, resolutionGroupKey: null }),
          ),
        }),
      );

      const result = await service.approve(1, {}, OTHER_ACTOR);
      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(ledgerService.appendAdjustmentLedger).not.toHaveBeenCalled();
    });

    it('이미 REJECTED → ConflictException', async () => {
      proposalRepo.findOne.mockResolvedValue(makeProposal({ resolutionGroupKey: null }));
      proposalRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({
          getOne: jest.fn().mockResolvedValue(
            makeProposal({ status: 'REJECTED', resolutionGroupKey: null }),
          ),
        }),
      );

      await expect(service.approve(1, {}, OTHER_ACTOR)).rejects.toBeInstanceOf(ConflictException);
    });

    it('자기 승인 → ForbiddenException', async () => {
      await expect(service.approve(1, {}, ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('0원 승인 → ledger append 없음', async () => {
      pricingResolver.resolveAt.mockResolvedValue({
        status: 'RESOLVED',
        pricePercent: 5,
        priceAdjustment: 'DISCOUNT',
        appliedDiscountHistoryId: 10,
        pricingResolution: 'HISTORY_MATCH',
      });
      // incremental = target - (current + sum) = 9500 - (9500 + 0) = 0
      // So settleAmount stays same → 0 difference
      const ledger = makeLedger({ settleAmount: '9500' });
      ledgerRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOne: jest.fn().mockResolvedValue(ledger) }),
      );

      const result = await service.approve(1, {}, OTHER_ACTOR);
      expect(ledgerService.appendAdjustmentLedger).not.toHaveBeenCalled();
    });

    it('재검증 차액 → 자동 override reason 설정', async () => {
      // proposedAmount=200 but pricing resolves to pricePercent=3 → target=9700, incremental=200
      // Make proposedAmount different (100) so finalAmount(200) ≠ proposedAmount(100)
      const proposal = makeProposal({ resolutionGroupKey: null, proposedAmount: '100' });
      proposalRepo.findOne.mockResolvedValue(proposal);
      proposalRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOne: jest.fn().mockResolvedValue(proposal) }),
      );

      pricingResolver.resolveAt.mockResolvedValue({
        status: 'RESOLVED',
        pricePercent: 3,
        priceAdjustment: 'DISCOUNT',
        appliedDiscountHistoryId: 20,
        pricingResolution: 'HISTORY_MATCH',
      });

      await service.approve(1, {}, OTHER_ACTOR);
      const updateCall = mgr.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('APPROVED'),
      );
      expect(updateCall).toBeDefined();
      const overrideReasonArg = updateCall[1][4]; // 5th param = amount_override_reason
      expect(overrideReasonArg).toBe('승인 시점 재검증에 의한 차액 자동 보정');
    });

    it('수동 override 금액 + 사유 → 정상', async () => {
      const result = await service.approve(
        1,
        { amount: '300', amountOverrideReason: '운영자 재량' },
        OTHER_ACTOR,
      );
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it('수동 override 금액 + 사유 없음 → BadRequestException', async () => {
      await expect(
        service.approve(1, { amount: '300' }, OTHER_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── approve (group) ───

  describe('approve (group)', () => {
    it('그룹 override 요청 → BadRequestException', async () => {
      proposalRepo.findOne.mockResolvedValue(
        makeProposal({ resolutionGroupKey: '100:5' }),
      );

      await expect(
        service.approve(1, { amount: '300', amountOverrideReason: '변경' }, OTHER_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('그룹 ALL_REJECTED → ConflictException', async () => {
      proposalRepo.findOne.mockResolvedValue(
        makeProposal({ resolutionGroupKey: '100:5' }),
      );
      proposalRepo.find.mockResolvedValue([
        makeProposal({ id: 1, status: 'REJECTED', resolutionGroupKey: '100:5' }),
        makeProposal({ id: 2, status: 'REJECTED', resolutionGroupKey: '100:5' }),
      ]);

      await expect(service.approve(1, {}, OTHER_ACTOR)).rejects.toBeInstanceOf(ConflictException);
    });

    it('그룹 MIXED → ConflictException', async () => {
      proposalRepo.findOne.mockResolvedValue(
        makeProposal({ resolutionGroupKey: '100:5' }),
      );
      proposalRepo.find.mockResolvedValue([
        makeProposal({ id: 1, status: 'PENDING', resolutionGroupKey: '100:5' }),
        makeProposal({ id: 2, status: 'APPROVED', resolutionGroupKey: '100:5' }),
      ]);

      await expect(service.approve(1, {}, OTHER_ACTOR)).rejects.toBeInstanceOf(ConflictException);
    });

    it('ALL_PENDING 그룹 정상 승인 (원자적)', async () => {
      const p1 = makeProposal({ id: 1, status: 'PENDING', resolutionGroupKey: '100:5', sourceLedgerId: 100, createdBy: null });
      const p2 = makeProposal({ id: 2, status: 'PENDING', resolutionGroupKey: '100:5', sourceLedgerId: 101, createdBy: null });
      const proposals = [p1, p2];

      // preview
      proposalRepo.findOne.mockResolvedValue(
        makeProposal({ resolutionGroupKey: '100:5' }),
      );
      // find (initial + post-commit reload)
      proposalRepo.find.mockResolvedValue(proposals);
      // company lock
      companyRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOneOrFail: jest.fn().mockResolvedValue({ id: 7 }) }),
      );
      // source ledger lock + reversal graph query
      const rootLedger = makeLedger({ id: 100, reversesLedgerId: null });
      const revLedger = makeLedger({ id: 101, reversesLedgerId: 100, baseAmount: '-10000', settleAmount: '-9500' });
      ledgerRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({
          getOne: jest.fn().mockResolvedValue(rootLedger),
          getMany: jest.fn().mockResolvedValue([rootLedger, revLedger]),
        }),
      );
      // locked proposals
      proposalRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getMany: jest.fn().mockResolvedValue(proposals) }),
      );
      // sum query
      mgr.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({
          select: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
        }),
      );

      await service.approve(1, {}, OTHER_ACTOR);

      expect(qr.commitTransaction).toHaveBeenCalled();
      // both proposals should get APPROVED UPDATE
      const approvedCalls = mgr.query.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes("'APPROVED'"),
      );
      expect(approvedCalls.length).toBe(2);
    });

    it('실제 graph node 누락 시 409', async () => {
      // proposals cover only root(100), but actual graph has root(100) + rev(101)
      const p1 = makeProposal({ id: 1, status: 'PENDING', resolutionGroupKey: '100:5', sourceLedgerId: 100, createdBy: null });
      const proposals = [p1];

      proposalRepo.findOne.mockResolvedValue(
        makeProposal({ resolutionGroupKey: '100:5' }),
      );
      proposalRepo.find.mockResolvedValue(proposals);
      companyRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOneOrFail: jest.fn().mockResolvedValue({ id: 7 }) }),
      );

      const rootLedger = makeLedger({ id: 100, reversesLedgerId: null });
      const revLedger = makeLedger({ id: 101, reversesLedgerId: 100, baseAmount: '-10000' });

      // source ledger lock returns only root (since proposals only reference root)
      // but reversal graph query returns root + rev
      let ledgerQbCallCount = 0;
      ledgerRepo.createQueryBuilder.mockImplementation(() => {
        ledgerQbCallCount++;
        if (ledgerQbCallCount <= 1) {
          // first call: source ledger lock (only id=100)
          return makeQueryBuilder({ getMany: jest.fn().mockResolvedValue([rootLedger]) });
        }
        // second call: all reversals for graph completeness
        return makeQueryBuilder({ getMany: jest.fn().mockResolvedValue([revLedger]) });
      });

      proposalRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getMany: jest.fn().mockResolvedValue(proposals) }),
      );

      await expect(service.approve(1, {}, OTHER_ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });
  });

  // ─── reject (single) ───

  describe('reject (single)', () => {
    beforeEach(() => {
      proposalRepo.findOne.mockResolvedValue(makeProposal({ resolutionGroupKey: null }));
      proposalRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({
          getOne: jest.fn().mockResolvedValue(makeProposal({ resolutionGroupKey: null })),
        }),
      );
      companyRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOneOrFail: jest.fn().mockResolvedValue({ id: 7 }) }),
      );
    });

    it('PENDING → REJECTED 정상', async () => {
      await service.reject(1, { reason: '반려 사유' }, OTHER_ACTOR);
      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(mgr.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'REJECTED'"),
        expect.any(Array),
      );
    });

    it('이미 REJECTED → idempotent 반환', async () => {
      proposalRepo.findOne.mockResolvedValue(makeProposal({ resolutionGroupKey: null }));
      proposalRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({
          getOne: jest.fn().mockResolvedValue(
            makeProposal({ status: 'REJECTED', resolutionGroupKey: null }),
          ),
        }),
      );

      await service.reject(1, { reason: '반려' }, OTHER_ACTOR);
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it('이미 APPROVED → ConflictException', async () => {
      proposalRepo.findOne.mockResolvedValue(makeProposal({ resolutionGroupKey: null }));
      proposalRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({
          getOne: jest.fn().mockResolvedValue(
            makeProposal({ status: 'APPROVED', resolutionGroupKey: null }),
          ),
        }),
      );

      await expect(service.reject(1, { reason: '반려' }, OTHER_ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('자기 반려 → ForbiddenException', async () => {
      await expect(service.reject(1, { reason: '반려' }, ACTOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ─── reject (group) ───

  describe('reject (group)', () => {
    it('그룹 ALL_APPROVED → ConflictException', async () => {
      proposalRepo.findOne.mockResolvedValue(
        makeProposal({ resolutionGroupKey: '100:5' }),
      );
      proposalRepo.find.mockResolvedValue([
        makeProposal({ id: 1, status: 'APPROVED', resolutionGroupKey: '100:5' }),
        makeProposal({ id: 2, status: 'APPROVED', resolutionGroupKey: '100:5' }),
      ]);

      await expect(service.reject(1, { reason: '반려' }, OTHER_ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('ALL_PENDING 그룹 정상 반려 (원자적)', async () => {
      const p1 = makeProposal({ id: 1, status: 'PENDING', resolutionGroupKey: '100:5', createdBy: null });
      const p2 = makeProposal({ id: 2, status: 'PENDING', resolutionGroupKey: '100:5', createdBy: null });
      const proposals = [p1, p2];

      proposalRepo.findOne.mockResolvedValue(
        makeProposal({ resolutionGroupKey: '100:5' }),
      );
      proposalRepo.find.mockResolvedValue(proposals);
      companyRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getOneOrFail: jest.fn().mockResolvedValue({ id: 7 }) }),
      );
      proposalRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder({ getMany: jest.fn().mockResolvedValue(proposals) }),
      );

      await service.reject(1, { reason: '반려 사유' }, OTHER_ACTOR);

      expect(qr.commitTransaction).toHaveBeenCalled();
      const rejectedCalls = mgr.query.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes("'REJECTED'"),
      );
      expect(rejectedCalls.length).toBe(2);
    });
  });

  // ─── createRepriceProposals ───

  describe('createRepriceProposals', () => {
    it('seed 별로 proposal 생성', async () => {
      const root = makeLedger({ id: 100 }) as any;
      proposalRepo.save.mockImplementation(async (entity: any) => ({ id: Math.random(), ...entity }));

      const result = await service.createRepriceProposals(
        {
          partnerCompanyId: 7,
          rootLedger: root,
          descendants: [],
          discountChangeId: 5,
          seeds: [
            { sourceLedgerId: 100, proposedAmount: 200n, reason: 'diff' },
          ],
        },
        mgr,
      );

      expect(result).toHaveLength(1);
      expect(result[0].resolutionGroupKey).toBe('100:5');
      expect(result[0].status).toBe('PENDING');
    });

    it('이미 존재하는 (sourceLedgerId, discountChangeId) → 기존 반환 (멱등)', async () => {
      const existing = makeProposal({ id: 99, sourceLedgerId: 100, discountChangeId: 5 });
      proposalRepo.findOne.mockResolvedValue(existing);

      const root = makeLedger({ id: 100 }) as any;
      const result = await service.createRepriceProposals(
        {
          partnerCompanyId: 7,
          rootLedger: root,
          descendants: [],
          discountChangeId: 5,
          seeds: [{ sourceLedgerId: 100, proposedAmount: 200n, reason: 'diff' }],
        },
        mgr,
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(99);
      expect(proposalRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── not found ───

  describe('not found', () => {
    it('approve 없는 id → NotFoundException', async () => {
      proposalRepo.findOne.mockResolvedValue(null);
      await expect(service.approve(999, {}, OTHER_ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reject 없는 id → NotFoundException', async () => {
      proposalRepo.findOne.mockResolvedValue(null);
      await expect(service.reject(999, { reason: 'x' }, OTHER_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
