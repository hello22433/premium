import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PartnerSettleReviewResolutionService } from './partner.settle.review.resolution.service';
import { PartnerSettleReviewResolutionEntity } from '../../entity/partner.settle.review.resolution.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerSettleReviewAuditEntity } from '../../entity/partner.settle.review.audit.entity';

function proposal(overrides: Partial<PartnerSettleReviewResolutionEntity> = {}): PartnerSettleReviewResolutionEntity {
  return {
    id: 10,
    ledgerId: 1,
    reviewCode: 'UNKNOWN_PROVIDER_EVENT',
    resolutionMode: 'DISCARD',
    proposedValues: null,
    evidenceRef: 'ticket://evidence/1',
    evidenceHash: 'evidence-hash',
    requestKey: 'review-request-1',
    payloadHash: '',
    payloadHashVersion: 'v1',
    status: 'PENDING',
    proposedBy: 100,
    proposedAt: new Date('2026-08-06T01:00:00Z'),
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    createdAt: new Date('2026-08-06T01:00:00Z'),
    updatedAt: new Date('2026-08-06T01:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

function ledger(overrides: Partial<PartnerSettleLedgerEntity> = {}): PartnerSettleLedgerEntity {
  return {
    id: 1,
    partnerCompanyId: 1,
    subItemKey: 'NONE',
    sourceType: 'ISSUANCE',
    orderDeliveryId: 2,
    galaxiaBarcodeLogId: null,
    occurredAt: null,
    baseAmount: null,
    discountAmount: '0',
    receivingCommissionAmount: '0',
    givingCommissionAmount: '0',
    vatAmount: '0',
    vatCalculationMode: 'NONE',
    feeTotalAmount: '0',
    appliedPricePercent: null,
    appliedPriceAdjustment: null,
    appliedDiscountHistoryId: null,
    pricingResolution: null,
    settleAmount: null,
    idempotencyKey: 'unknown:1',
    settleBatchId: null,
    status: 'NEEDS_REVIEW',
    reviewCode: 'UNKNOWN_PROVIDER_EVENT',
    reviewResolution: 'PENDING',
    resolvedBy: null,
    resolvedAt: null,
    providerEvidenceRef: null,
    providerEvidenceHash: null,
    memo: null,
    reversesLedgerId: null,
    transitionObservationId: null,
    transitionSequenceNo: null,
    transitionAllocationNo: null,
    sourceEventIdOrigin: null,
    reviewResolutionId: null,
    manualLedgerProposalId: null,
    orphanInboxRowId: null,
    paymentVarianceProposalId: null,
    createdAt: new Date('2026-08-06T01:00:00Z'),
    updatedAt: new Date('2026-08-06T01:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('PartnerSettleReviewResolutionService', () => {
  const pricingResolver = { lockPolicyForRead: jest.fn(), resolveAt: jest.fn() };

  afterEach(() => jest.clearAllMocks());

  it('returns an existing proposal for the same requestKey and canonical payload', async () => {
    const resolutionRepository = { findOne: jest.fn() };
    const dataSource = { transaction: jest.fn() };
    const service = new PartnerSettleReviewResolutionService(
      resolutionRepository as never,
      pricingResolver as never,
      dataSource as never,
    );
    const command = {
      ledgerId: 1,
      reviewCode: 'UNKNOWN_PROVIDER_EVENT' as const,
      resolutionMode: 'DISCARD' as const,
      proposedValues: null,
      evidenceRef: 'ticket://evidence/1',
      reason: 'not a settlement',
      requestKey: 'review-request-1',
    };
    const hash = (service as any).payloadHash((service as any).normalize(command), command.reviewCode);
    const existing = proposal({ payloadHash: hash, status: 'APPROVED' });
    resolutionRepository.findOne.mockResolvedValue(existing);

    await expect(service.propose(command, 100)).resolves.toEqual({ proposal: existing, ledgerIds: [] });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects requestKey reuse with a different payload', async () => {
    const resolutionRepository = { findOne: jest.fn().mockResolvedValue(proposal({ payloadHash: 'different' })) };
    const service = new PartnerSettleReviewResolutionService(
      resolutionRepository as never,
      pricingResolver as never,
      { transaction: jest.fn() } as never,
    );

    await expect(
      service.propose(
        {
          ledgerId: 1,
          reviewCode: 'UNKNOWN_PROVIDER_EVENT',
          resolutionMode: 'DISCARD',
          evidenceRef: 'ticket://evidence/1',
          requestKey: 'review-request-1',
        },
        100,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['01', '-0', ' 1 '])('rejects non-canonical baseAmount %p before BigInt parsing', (baseAmount) => {
    const service = new PartnerSettleReviewResolutionService({} as never, pricingResolver as never, {} as never);

    expect(() =>
      (service as any).normalize({
        ledgerId: 1,
        reviewCode: 'PRICE_UNRECOVERABLE',
        resolutionMode: 'SET_PRICE',
        proposedValues: { baseAmount, priceEvidenceRef: 'evidence' },
        evidenceRef: 'evidence',
        requestKey: 'valid_key-1',
      }),
    ).toThrow(BadRequestException);
  });

  it.each(['bad key', 'a'.repeat(129), 'key!'])('rejects malformed requestKey %p', (requestKey) => {
    const service = new PartnerSettleReviewResolutionService({} as never, pricingResolver as never, {} as never);

    expect(() =>
      (service as any).normalize({
        ledgerId: 1,
        reviewCode: 'UNKNOWN_PROVIDER_EVENT',
        resolutionMode: 'DISCARD',
        evidenceRef: 'evidence',
        requestKey,
      }),
    ).toThrow(BadRequestException);
  });

  it.each(['', 'evidence\u0000ref', 'a'.repeat(1001)])('rejects invalid required evidence reference', (evidenceRef) => {
    const service = new PartnerSettleReviewResolutionService({} as never, pricingResolver as never, {} as never);

    expect(() =>
      (service as any).normalize({
        ledgerId: 1,
        reviewCode: 'UNKNOWN_PROVIDER_EVENT',
        resolutionMode: 'DISCARD',
        evidenceRef,
        requestKey: 'valid_key-1',
      }),
    ).toThrow(BadRequestException);
  });

  it.each([
    [
      'SET_TIME',
      { occurredAt: '2026-08-06 10:00:00', baseAmount: '100' },
      ledger({ reviewCode: 'TIME_UNRECOVERABLE' }),
    ],
    [
      'SET_PRICE',
      { baseAmount: '100', priceEvidenceRef: 'evidence', occurredAt: '2026-08-06 10:00:00' },
      ledger({ reviewCode: 'PRICE_UNRECOVERABLE' }),
    ],
  ] as const)('rejects facts outside the %s proposedValues contract', (mode, proposedValues, target) => {
    const service = new PartnerSettleReviewResolutionService({} as never, pricingResolver as never, {} as never);

    expect(() => (service as any).validateValues(mode, proposedValues, target)).toThrow(BadRequestException);
  });

  it('derives omitted RECLASSIFY source facts only at approval', () => {
    const service = new PartnerSettleReviewResolutionService({} as never, pricingResolver as never, {} as never);
    const values = { reclassifyTo: { occurredAt: '2026-08-06 10:00:00', baseAmount: '100' } };

    expect((service as any).reclassifyFacts(values)).toEqual(
      expect.objectContaining({ sourceType: undefined, subItemKey: undefined }),
    );
    expect((service as any).reclassifyFacts(values, ledger({ sourceType: 'EXCHANGE', subItemKey: 'MOBILE' }))).toEqual({
      sourceType: 'EXCHANGE',
      subItemKey: 'MOBILE',
      occurredAt: '2026-08-06 10:00:00',
      baseAmount: '100',
    });
  });

  it('replays the same terminal decision and rejects the opposite decision', async () => {
    const approved = proposal({ status: 'APPROVED', resolutionMode: 'DISCARD', decidedBy: 200 });
    const proposalQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(approved),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(proposalQb) }),
    };
    const service = new PartnerSettleReviewResolutionService(
      {} as never,
      pricingResolver as never,
      { transaction: jest.fn((run) => run(manager)) } as never,
    );

    await expect(service.approve(10, 300, 'retry')).resolves.toEqual({ proposal: approved, ledgerIds: [] });
    await expect(service.reject(10, 300, 'reject')).rejects.toBeInstanceOf(ConflictException);
  });
  it('limits negative RECLASSIFY originals to the placeholder partner and positive NORMAL rows', async () => {
    const queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const ledgerRepo = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) };
    const manager = { getRepository: jest.fn().mockReturnValue(ledgerRepo) };
    const service = new PartnerSettleReviewResolutionService({} as never, pricingResolver as never, {} as never);

    await expect(
      (service as any).appendReclassifiedReversals(
        ledger({ partnerCompanyId: 9 }),
        proposal(),
        { sourceType: 'ISSUANCE', subItemKey: 'NONE', occurredAt: '2026-08-06 10:00:00', baseAmount: '-100' },
        manager,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('l.partnerCompanyId = :partnerCompanyId', {
      partnerCompanyId: 9,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('l.status = :status', { status: 'NORMAL' });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('l.baseAmount > 0');
  });

  it('hashes NFC and trimmed equivalent proposal payloads identically', () => {
    const service = new PartnerSettleReviewResolutionService({} as never, pricingResolver as never, {} as never);
    const base = {
      ledgerId: 1,
      reviewCode: 'PRICE_UNRECOVERABLE' as const,
      resolutionMode: 'SET_PRICE' as const,
      requestKey: 'valid_key-1',
    };

    const first = (service as any).normalize({
      ...base,
      evidenceRef: '  cafe\u0301  ',
      reason: '  note  ',
      proposedValues: { baseAmount: '100', priceEvidenceRef: '  proof  ', memo: '   ' },
    });
    const second = (service as any).normalize({
      ...base,
      evidenceRef: 'café',
      reason: 'note',
      proposedValues: { baseAmount: '100', priceEvidenceRef: 'proof' },
    });

    expect((service as any).payloadHash(first, base.reviewCode)).toBe(
      (service as any).payloadHash(second, base.reviewCode),
    );
  });

  it('blocks self approval before changing ledger state', async () => {
    const pending = proposal();
    const proposalQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(pending),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(proposalQb) }),
    };
    const dataSource = { transaction: jest.fn((run) => run(manager)) };
    const service = new PartnerSettleReviewResolutionService(
      {} as never,
      pricingResolver as never,
      dataSource as never,
    );

    await expect(service.approve(10, 100, 'approve')).rejects.toBeInstanceOf(ForbiddenException);
    expect(manager.getRepository).toHaveBeenCalledTimes(1);
  });

  it('approves DISCARD atomically and appends before/after audit', async () => {
    const pending = proposal();
    const before = ledger();
    const after = ledger({ reviewResolution: 'DISCARDED', resolvedBy: 200, memo: 'approved' });
    const resolutionQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(pending),
    };
    const ledgerQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(before),
    };
    const resolutionRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(resolutionQb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const ledgerRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(ledgerQb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOneByOrFail: jest.fn().mockResolvedValue(after),
    };
    const auditRepo = { insert: jest.fn().mockResolvedValue({}) };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === PartnerSettleReviewResolutionEntity) return resolutionRepo;
        if (entity === PartnerSettleLedgerEntity) return ledgerRepo;
        if (entity === PartnerSettleReviewAuditEntity) return auditRepo;
        throw new Error('unexpected repository');
      }),
    };
    const service = new PartnerSettleReviewResolutionService(
      {} as never,
      pricingResolver as never,
      { transaction: jest.fn((run) => run(manager)) } as never,
    );

    const result = await service.approve(10, 200, 'approved');

    expect(result.proposal.status).toBe('APPROVED');
    expect(result.ledgerIds).toEqual([]);
    expect(ledgerRepo.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        reviewResolution: 'DISCARDED',
        resolvedBy: 200,
        memo: 'approved',
      }),
    );
    expect(auditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerId: 1,
        beforeReviewResolution: 'PENDING',
        afterReviewResolution: 'DISCARDED',
        resolutionId: 10,
        actorId: 200,
        reason: 'approved',
      }),
    );
    expect(resolutionRepo.update).toHaveBeenCalledWith(
      { id: 10, status: 'PENDING' },
      expect.objectContaining({ status: 'APPROVED', decidedBy: 200, decisionReason: 'approved' }),
    );
  });
});
