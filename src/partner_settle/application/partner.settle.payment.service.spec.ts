import { ConflictException, NotFoundException } from '@nestjs/common';
import { PartnerSettlePaymentService } from './partner.settle.payment.service';
import { PartnerSettleFeatureFlag } from './partner.settle.feature.flag';

function makeFeatureFlag(paidEnabled = true) {
  return {
    isPaidEnabled: paidEnabled,
    isConfirmEnabled: true,
    isEnabled: true,
    isReviewResolutionEnabled: true,
    isEnabledFor: jest.fn().mockReturnValue(true),
  } as unknown as PartnerSettleFeatureFlag;
}

function makeQb(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    getOneOrFail: jest.fn().mockResolvedValue({ id: 1 }),
    getRawOne: jest.fn().mockResolvedValue({ total: '50000' }),
  };
  Object.assign(qb, overrides);
  return qb;
}

function makeRepo(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((o: any) => ({ ...o, id: 1 })),
    save: jest.fn(async (o: any) => ({ ...o, id: o.id ?? 1 })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue(makeQb()),
    ...overrides,
  };
}

function makeManager() {
  const repos: Record<string, ReturnType<typeof makeRepo>> = {};

  const getRepository = jest.fn().mockImplementation((entity: any) => {
    const name = entity.name ?? String(entity);
    if (!repos[name]) repos[name] = makeRepo();
    return repos[name];
  });

  return {
    getRepository,
    createQueryBuilder: jest.fn().mockReturnValue(makeQb()),
    repos,
  };
}

function makeDataSource(manager: ReturnType<typeof makeManager>) {
  return {
    createQueryRunner: jest.fn().mockReturnValue({
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager,
    }),
  };
}

function makeSut(paidEnabled = true) {
  const manager = makeManager();
  const dataSource = makeDataSource(manager);
  const featureFlag = makeFeatureFlag(paidEnabled);
  const service = new PartnerSettlePaymentService(dataSource as any, featureFlag);
  return { service, manager, dataSource, featureFlag };
}

const dto = {
  paidRequestKey: 'paid-key-1',
  actualPaidAmount: '50000',
  paymentEvidenceRef: 'REF-001',
  memo: '메모',
};

describe('PartnerSettlePaymentService', () => {
  it('paid flag OFF → 404', async () => {
    const { service } = makeSut(false);
    await expect(service.paid(1, dto, 42)).rejects.toThrow(NotFoundException);
  });

  it('batch 미존재 → 404', async () => {
    const { service, manager } = makeSut();
    // PartnerSettleBatchEntity.findOne → null
    manager.getRepository.mockImplementation((entity: any) => {
      const name = entity.name ?? String(entity);
      if (name === 'PartnerSettleBatchEntity') {
        return makeRepo({ findOne: jest.fn().mockResolvedValue(null) });
      }
      return makeRepo();
    });
    await expect(service.paid(1, dto, 42)).rejects.toThrow(NotFoundException);
  });

  it('PAID batch + 새 requestKey → 409', async () => {
    const { service, manager } = makeSut();
    const batch = {
      id: 1, partnerCompanyId: 1, periodEnd: '2026-08-01',
      status: 'PAID', batchType: 'NORMAL',
    };
    // batch findOne → PAID batch, then locked getOne also returns same
    manager.getRepository.mockImplementation((entity: any) => {
      const name = entity.name ?? String(entity);
      if (name === 'PartnerSettleBatchEntity') {
        return makeRepo({
          findOne: jest.fn().mockResolvedValue(batch),
          createQueryBuilder: jest.fn().mockReturnValue(
            makeQb({ getOne: jest.fn().mockResolvedValue(batch) }),
          ),
        });
      }
      if (name === 'PartnerCompanyEntity') {
        return makeRepo({
          createQueryBuilder: jest.fn().mockReturnValue(
            makeQb({ getOneOrFail: jest.fn().mockResolvedValue({ id: 1 }) }),
          ),
        });
      }
      return makeRepo();
    });
    await expect(service.paid(1, dto, 42)).rejects.toThrow(ConflictException);
  });

  it('PAID batch + 동일 paidRequestKey 재시도 → 200 (멱등)', async () => {
    const { service, manager } = makeSut();
    const batch = {
      id: 1, partnerCompanyId: 1, periodEnd: '2026-08-01',
      status: 'PAID', batchType: 'NORMAL',
    };
    const payloadHash = (service as any).paidPayloadHash(1, dto);
    const existingRequest = {
      id: 10,
      paidRequestKey: dto.paidRequestKey,
      batchId: 1,
      payloadHash,
      status: 'PAID',
    };
    // batch findOne/lock → PAID batch, payment request → existing PAID request
    manager.getRepository.mockImplementation((entity: any) => {
      const name = entity.name ?? String(entity);
      if (name === 'PartnerSettleBatchEntity') {
        return makeRepo({
          findOne: jest.fn().mockResolvedValue(batch),
          createQueryBuilder: jest.fn().mockReturnValue(
            makeQb({ getOne: jest.fn().mockResolvedValue(batch) }),
          ),
        });
      }
      if (name === 'PartnerCompanyEntity') {
        return makeRepo({
          createQueryBuilder: jest.fn().mockReturnValue(
            makeQb({ getOneOrFail: jest.fn().mockResolvedValue({ id: 1 }) }),
          ),
        });
      }
      if (name === 'PartnerSettlePaymentRequestEntity') {
        return makeRepo({
          createQueryBuilder: jest.fn().mockReturnValue(
            makeQb({ getOne: jest.fn().mockResolvedValue(existingRequest) }),
          ),
        });
      }
      return makeRepo();
    });
    const result = await service.paid(1, dto, 42);
    expect(result.statusCode).toBe(200);
    expect(result.result.status).toBe('PAID');
    expect(result.result.paymentRequestId).toBe(10);
  });

  it('payload hash 는 memo 정규화 후 동일하면 같은 값', () => {
    const { service } = makeSut();
    const h1 = (service as any).paidPayloadHash(1, { ...dto, memo: ' 메모 ' });
    const h2 = (service as any).paidPayloadHash(1, { ...dto, memo: '메모' });
    expect(h1).toBe(h2);
  });

  it('payload hash 는 actualPaidAmount 가 다르면 다른 값', () => {
    const { service } = makeSut();
    const h1 = (service as any).paidPayloadHash(1, dto);
    const h2 = (service as any).paidPayloadHash(1, { ...dto, actualPaidAmount: '60000' });
    expect(h1).not.toBe(h2);
  });
});
