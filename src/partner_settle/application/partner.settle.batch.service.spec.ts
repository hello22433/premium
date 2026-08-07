import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { PartnerSettleBatchService } from './partner.settle.batch.service';
import { PartnerSettleFeatureFlag } from './partner.settle.feature.flag';

/**
 * PartnerSettleBatchService confirm/unconfirm/holdRelease 단위 테스트.
 *
 * DB 의존 로직(QueryRunner·DataSource)을 mocking 하여 비즈니스 규칙만 검증한다.
 * DB 통합 테스트는 별도 *.db-integration-test.ts 에서 수행.
 */

// ── helpers ──

function makeBatchRepo(overrides: Record<string, jest.Mock> = {}) {
  return {
    createQueryBuilder: jest.fn().mockReturnValue({
      andWhere: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
      limit: jest.fn().mockReturnThis(),
    }),
    findOne: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeConfigRepo(config: Record<string, unknown> | null = null) {
  return {
    findOne: jest.fn().mockResolvedValue(config),
  };
}

function makeManager(repos: Record<string, unknown> = {}) {
  const getRepository = jest.fn().mockImplementation((entity: any) => {
    const name = entity.name ?? entity;
    return repos[name] ?? {
      create: jest.fn((o: any) => o),
      save: jest.fn(async (o: any) => ({ ...o, id: 1 })),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
        getOneOrFail: jest.fn().mockResolvedValue({ id: 1 }),
        getMany: jest.fn().mockResolvedValue([]),
        getCount: jest.fn().mockResolvedValue(0),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ total: '0', cnt: 0 }),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      }),
    };
  });

  return {
    getRepository,
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue({ total: '0', cnt: 0 }),
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    }),
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

function makeFeatureFlag(confirmEnabled = true) {
  return {
    isConfirmEnabled: confirmEnabled,
    isPaidEnabled: false,
    isEnabled: true,
    isReviewResolutionEnabled: true,
    isEnabledFor: jest.fn().mockReturnValue(true),
  } as unknown as PartnerSettleFeatureFlag;
}

function makeSut(overrides: {
  confirmEnabled?: boolean;
  config?: Record<string, unknown> | null;
} = {}) {
  const batchRepo = makeBatchRepo();
  const configRepo = makeConfigRepo(overrides.config ?? { partnerCompanyId: 1, nextNormalPeriodEnd: '2026-08-01', source: 'CUTOVER_MANUAL' });
  const manager = makeManager();
  const dataSource = makeDataSource(manager);
  const featureFlag = makeFeatureFlag(overrides.confirmEnabled ?? true);

  const service = new PartnerSettleBatchService(
    batchRepo as any,
    configRepo as any,
    dataSource as any,
    featureFlag,
  );

  return { service, batchRepo, configRepo, manager, dataSource, featureFlag };
}

// ── tests ──

describe('PartnerSettleBatchService', () => {
  describe('confirm', () => {
    it('confirm flag OFF 일 때 404', async () => {
      const { service } = makeSut({ confirmEnabled: false });
      await expect(
        service.confirm(
          { partnerCompanyId: 1, periodEnd: '2026-08-01', requestKey: 'key-1' },
          42,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('config 미설정 시 400', async () => {
      const { service, manager } = makeSut({ config: null });
      // config findOne → null
      manager.getRepository.mockImplementation((entity: any) => {
        const name = entity.name ?? entity;
        if (name === 'PartnerSettleConfigEntity') {
          return { findOne: jest.fn().mockResolvedValue(null) };
        }
        return {
          create: jest.fn((o: any) => o),
          save: jest.fn(async (o: any) => ({ ...o, id: 1 })),
          findOne: jest.fn().mockResolvedValue(null),
          createQueryBuilder: jest.fn().mockReturnValue({
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(null),
            getOneOrFail: jest.fn().mockResolvedValue({ id: 1, type: 'GALAXIA' }),
            getMany: jest.fn().mockResolvedValue([]),
            getCount: jest.fn().mockResolvedValue(0),
            getRawMany: jest.fn().mockResolvedValue([]),
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
          }),
        };
      });

      await expect(
        service.confirm(
          { partnerCompanyId: 1, periodEnd: '2026-09-01', requestKey: 'key-2' },
          42,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('holdRelease', () => {
    it('ON_HOLD 가 아닌 ledger 는 400', async () => {
      const { service, manager } = makeSut();
      manager.getRepository.mockImplementation(() => ({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue({ id: 1, status: 'NORMAL' }),
        }),
        update: jest.fn(),
        create: jest.fn((o: any) => o),
        save: jest.fn(async (o: any) => o),
      }));

      await expect(service.holdRelease(1, '사유', 42)).rejects.toThrow(BadRequestException);
    });
  });

  describe('unconfirm — 경쟁 confirm 귀속 재검증', () => {
    it('preview 시점 미정산이던 ledger 가 경쟁 confirm 으로 batch 에 귀속되면, anchor 아래 재확정한 batch 를 잠그고 검증한다', async () => {
      const { service, manager } = makeSut();

      // ledger 읽기 순서: (1) preview → (2) anchor 아래 재확정 → (3) 잠금 후 재조회
      const ledgerQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          // (1) preview: settleBatchId 미선택 — 이 시점엔 미정산
          .mockResolvedValueOnce([{ id: 1, partnerCompanyId: 1 }])
          // (2) anchor 아래 재확정: 경쟁 confirm 이 batch 99 로 귀속시킴
          .mockResolvedValueOnce([{ id: 1, settleBatchId: 99 }])
          // (3) 잠금 후 재조회
          .mockResolvedValueOnce([{ id: 1, partnerCompanyId: 1, settleBatchId: 99 }]),
      };

      // batch 99 는 CONFIRMED_UNPAID/NORMAL 이지만 뒤에 비CANCELED batch 100 존재 → 해제 불가
      const batchQb = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          { id: 99, status: 'CONFIRMED_UNPAID', batchType: 'NORMAL', partnerCompanyId: 1, periodEnd: '2026-08-01' },
        ]),
        getOne: jest.fn().mockResolvedValue({ id: 100 }), // 뒤 batch 존재
      };

      const anchorQb = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOneOrFail: jest.fn().mockResolvedValue({ id: 1 }),
      };

      manager.getRepository.mockImplementation((entity: any) => {
        const name = entity.name ?? entity;
        if (name === 'PartnerCompanyEntity') {
          return { createQueryBuilder: jest.fn().mockReturnValue(anchorQb) };
        }
        if (name === 'PartnerSettleLedgerEntity') {
          return { createQueryBuilder: jest.fn().mockReturnValue(ledgerQb), update: jest.fn() };
        }
        if (name === 'PartnerSettleBatchEntity') {
          return { createQueryBuilder: jest.fn().mockReturnValue(batchQb), update: jest.fn() };
        }
        // release request / release / cancel_recon 등
        return {
          findOne: jest.fn().mockResolvedValue(null),
          find: jest.fn().mockResolvedValue([]),
          create: jest.fn((o: any) => o),
          save: jest.fn(async (o: any) => ({ ...o, id: 1 })),
          update: jest.fn(),
        };
      });

      await expect(
        service.unconfirm(50, { requestKey: 'rk-1', reason: '사유', ledgerIds: [1] }, 42),
      ).rejects.toThrow(ConflictException);

      // batch 99 가 실제로 잠기고(3b) carry 검증(getOne)까지 수행되었는지 확인
      expect(batchQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(batchQb.getMany).toHaveBeenCalled();
      expect(batchQb.getOne).toHaveBeenCalled();
    });
  });

  describe('payload hash', () => {
    it('같은 confirm 요청은 같은 hash 를 생성한다', () => {
      const { service } = makeSut();
      const dto = {
        partnerCompanyId: 1,
        periodEnd: '2026-08-01',
        requestKey: 'key-1',
        excludeItems: [
          { ledgerId: 3, reason: '사유B', mode: 'SKIP_ONCE' as const },
          { ledgerId: 1, reason: '사유A', mode: 'HOLD' as const },
        ],
      };
      const hash1 = (service as any).confirmPayloadHash(dto);
      const hash2 = (service as any).confirmPayloadHash({
        ...dto,
        excludeItems: [
          { ledgerId: 1, reason: '사유A', mode: 'HOLD' as const },
          { ledgerId: 3, reason: '사유B', mode: 'SKIP_ONCE' as const },
        ],
      });
      expect(hash1).toBe(hash2); // excludeItems 순서 무관
    });
    it('같은 unconfirm 요청이라도 pathBatchId 가 다르면 다른 hash', () => {
      const { service } = makeSut();
      const dto = { requestKey: 'key-1', reason: '사유', ledgerIds: [1, 2] };
      const h1 = (service as any).unconfirmPayloadHash(10, dto);
      const h2 = (service as any).unconfirmPayloadHash(20, dto);
      expect(h1).not.toBe(h2);
    });

    it('같은 unconfirm 요청 + 같은 pathBatchId → 같은 hash', () => {
      const { service } = makeSut();
      const dto = { requestKey: 'key-1', reason: '사유', ledgerIds: [2, 1] };
      const h1 = (service as any).unconfirmPayloadHash(10, dto);
      const h2 = (service as any).unconfirmPayloadHash(10, { ...dto, ledgerIds: [1, 2] });
      expect(h1).toBe(h2);
    });
  });
});
