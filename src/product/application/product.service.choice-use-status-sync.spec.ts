jest.mock('typeorm-transactional', () => ({
  IsolationLevel: { READ_COMMITTED: 'READ COMMITTED' },
  Transactional: () => () => undefined,
}));

import { ProductService } from './product.service';
import { IProductUseStatus } from '../interface/product.status';
import { ProductUpdateHistoryEntity } from '../../entity/product.update.history.entity';
import { ProductUseStatusAutoHistoryKey } from '../domain/product.update.history.key.name';

// 구성상품 useStatus 변경 시 그 상품을 포함한 초이스쿠폰의 useStatus 동기화 검증.
describe('ProductService.updatePartial - 초이스쿠폰 사용상태 자동 반영', () => {
  const user = { id: 7 } as any;

  // products: id -> { id, code, useStatus, type }
  // mappings: { choiceProductId, productId }[]
  // existingHistories: 초이스쿠폰의 기존 사용상태 이력. 마지막 이력의 key 로 자동/수동을 구분한다.
  const createService = (
    products: Record<number, any>,
    mappings: { choiceProductId: number; productId: number }[],
    existingHistories: Partial<ProductUpdateHistoryEntity>[] = [],
  ) => {
    const saved: any[] = [];
    const lockedChoiceIds: number[] = [];
    const insertedHistories: ProductUpdateHistoryEntity[] = [];

    const productRepository = {
      findOne: jest.fn(async ({ where: { id }, lock }: any) => {
        if (lock?.mode === 'pessimistic_write') {
          lockedChoiceIds.push(id);
        }
        return products[id] ?? null;
      }),
      createQueryBuilder: jest.fn(() => {
        let ids: number[] = [];
        const qb: any = {
          withDeleted: jest.fn((): any => qb),
          where: jest.fn((_condition: string, params: { ids: number[] }) => {
            ids = params.ids;
            return qb;
          }),
          orderBy: jest.fn((): any => qb),
          setLock: jest.fn((): any => qb),
          getMany: jest.fn(async () => ids.map((productId) => products[productId]).filter((p) => p != null)),
        };
        return qb;
      }),
      save: jest.fn(async (entity: any) => {
        saved.push({ id: entity.id, useStatus: entity.useStatus });
        products[entity.id] = entity;
        return entity;
      }),
      // delete 경로용. In(idList) 조건으로 넘어온다.
      find: jest.fn(async ({ where: { id } }: any) => {
        const ids: number[] = id?._value ?? [];
        return ids.map((productId) => products[productId]).filter((p) => p != null);
      }),
      // soft delete 는 deletedAt 을 채운다. 이후 재계산에서 비정상으로 잡혀야 한다.
      softDelete: jest.fn(async ({ id }: any) => {
        const ids: number[] = id?._value ?? [];
        for (const productId of ids) {
          if (products[productId]) {
            products[productId] = { ...products[productId], deletedAt: new Date() };
          }
        }
      }),
    };

    const productChoiceMappingRepository = {
      find: jest.fn(async ({ where }: any) => {
        if (where.productId !== undefined) {
          return mappings.filter((m) => m.productId === where.productId);
        }
        return mappings.filter((m) => m.choiceProductId === where.choiceProductId);
      }),
    };

    const productUpdateHistoryRepository = {
      insert: jest.fn(async (rows: ProductUpdateHistoryEntity[]) => insertedHistories.push(...rows)),
      // wasAutoUnused 판별용. productId 의 마지막 사용상태 이력 1건을 돌려준다.
      findOne: jest.fn(async ({ where: { productId } }: any) => {
        const matched = existingHistories.filter((history) => history.productId === productId);
        return matched.length > 0 ? matched[matched.length - 1] : null;
      }),
    };

    const userSyncProductEventMappingRepository = { softDelete: jest.fn() };

    const service = new ProductService(
      productRepository as any,
      {} as any, // partnerCompany
      {} as any, // brand
      {} as any, // classification
      productUpdateHistoryRepository as any,
      {} as any, // userSyncProductEvent
      userSyncProductEventMappingRepository as any,
      {} as any, // productLike
      {} as any, // ssgEvent
      {} as any, // user
      {} as any, // productSharedListFile
      productChoiceMappingRepository as any,
      {} as any, // activityLogService
      {} as any, // fileStorage
    );

    return { service, saved, lockedChoiceIds, insertedHistories, products, userSyncProductEventMappingRepository };
  };

  const product = (id: number, useStatus: IProductUseStatus, code = `P${id}`) => ({
    id,
    code,
    useStatus,
    type: 'GENERAL',
    deletedAt: null,
  });

  it('구성상품이 미사용이 되면 초이스쿠폰도 미사용이 된다', async () => {
    const products = {
      1: product(1, IProductUseStatus.USE),
      2: product(2, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.USE, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, products: after } = createService(products, [
      { choiceProductId: 100, productId: 1 },
      { choiceProductId: 100, productId: 2 },
    ]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.UNUSED, reason: '고객사 요청' } as any);

    expect(after[100].useStatus).toBe(IProductUseStatus.UNUSED);
  });

  it('자동으로 미사용된 초이스쿠폰은 마지막 구성상품이 복구되면 사용으로 되돌아온다', async () => {
    const products = {
      1: product(1, IProductUseStatus.UNUSED),
      2: product(2, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.UNUSED, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, products: after } = createService(
      products,
      [
        { choiceProductId: 100, productId: 1 },
        { choiceProductId: 100, productId: 2 },
      ],
      // 직전에 자동으로 미사용 처리된 이력
      [
        {
          productId: 100,
          key: ProductUseStatusAutoHistoryKey,
          beforeValue: IProductUseStatus.USE,
          afterValue: IProductUseStatus.UNUSED,
        },
      ],
    );

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.USE, reason: '고객사 요청' } as any);

    expect(after[100].useStatus).toBe(IProductUseStatus.USE);
  });

  // 리뷰 지적(High): 수동 미사용이 구성상품 복구만으로 자동 USE 가 되면 안 된다.
  it('관리자가 수동으로 미사용한 초이스쿠폰은 구성상품이 복구돼도 미사용으로 남는다', async () => {
    const products = {
      1: product(1, IProductUseStatus.UNUSED),
      2: product(2, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.UNUSED, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, products: after } = createService(
      products,
      [
        { choiceProductId: 100, productId: 1 },
        { choiceProductId: 100, productId: 2 },
      ],
      // 관리자가 직접 미사용으로 바꾼 이력
      [
        {
          productId: 100,
          key: 'useStatus',
          beforeValue: IProductUseStatus.USE,
          afterValue: IProductUseStatus.UNUSED,
        },
      ],
    );

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.USE, reason: '고객사 요청' } as any);

    expect(after[100].useStatus).toBe(IProductUseStatus.UNUSED);
  });

  // 자동 반영 도입 전에 만들어진 초이스쿠폰은 이력이 없다.
  // 기존 useStatus 값은 모두 관리자가 넣은 값이므로 수동으로 보고 복구하지 않는다.
  it('사용상태 이력이 없는 초이스쿠폰은 구성상품이 복구돼도 미사용으로 남는다', async () => {
    const products = {
      1: product(1, IProductUseStatus.UNUSED),
      2: product(2, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.UNUSED, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, products: after } = createService(products, [
      { choiceProductId: 100, productId: 1 },
      { choiceProductId: 100, productId: 2 },
    ]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.USE, reason: '고객사 요청' } as any);

    expect(after[100].useStatus).toBe(IProductUseStatus.UNUSED);
  });

  it('다른 구성상품이 아직 미사용이면 초이스쿠폰은 미사용으로 남는다', async () => {
    const products = {
      1: product(1, IProductUseStatus.UNUSED),
      2: product(2, IProductUseStatus.UNUSED),
      100: { ...product(100, IProductUseStatus.UNUSED, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, products: after } = createService(products, [
      { choiceProductId: 100, productId: 1 },
      { choiceProductId: 100, productId: 2 },
    ]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.USE } as any);

    expect(after[100].useStatus).toBe(IProductUseStatus.UNUSED);
  });

  it('영구미사용 구성상품이 생겨도 초이스쿠폰은 미사용이지 영구미사용이 아니다', async () => {
    const products = {
      1: product(1, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.USE, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, products: after } = createService(products, [{ choiceProductId: 100, productId: 1 }]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.PERMANENTLY_UNUSED } as any);

    expect(after[100].useStatus).toBe(IProductUseStatus.UNUSED);
  });

  it('한 구성상품이 여러 초이스쿠폰에 묶여 있으면 전부 반영한다', async () => {
    const products = {
      1: product(1, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.USE, 'CHOICE100'), type: 'CHOICE' },
      200: { ...product(200, IProductUseStatus.USE, 'CHOICE200'), type: 'CHOICE' },
    };
    const { service, products: after } = createService(products, [
      { choiceProductId: 100, productId: 1 },
      { choiceProductId: 200, productId: 1 },
    ]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.UNUSED } as any);

    expect(after[100].useStatus).toBe(IProductUseStatus.UNUSED);
    expect(after[200].useStatus).toBe(IProductUseStatus.UNUSED);
  });

  it('여러 초이스쿠폰에 묶인 구성상품 변경 시 choiceProductId 오름차순으로 락을 잡는다', async () => {
    const products = {
      1: product(1, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.USE, 'CHOICE100'), type: 'CHOICE' },
      200: { ...product(200, IProductUseStatus.USE, 'CHOICE200'), type: 'CHOICE' },
    };
    const { service, lockedChoiceIds } = createService(products, [
      { choiceProductId: 200, productId: 1 },
      { choiceProductId: 100, productId: 1 },
    ]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.UNUSED } as any);

    expect(lockedChoiceIds).toEqual([100, 200]);
  });

  it('초이스쿠폰에 묶이지 않은 상품이면 아무것도 하지 않는다', async () => {
    const products = { 1: product(1, IProductUseStatus.USE) };
    const { service, saved } = createService(products, []);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.UNUSED } as any);

    // 자기 자신 저장 1건뿐, 초이스쿠폰 저장 없음
    expect(saved).toEqual([{ id: 1, useStatus: IProductUseStatus.UNUSED }]);
  });

  it('useStatus 변경이 아니면 초이스쿠폰을 건드리지 않는다', async () => {
    const products = {
      1: product(1, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.UNUSED, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, products: after } = createService(products, [{ choiceProductId: 100, productId: 1 }]);

    await service.updatePartial(user, { id: 1, memo: '메모만 수정' } as any);

    expect(after[100].useStatus).toBe(IProductUseStatus.UNUSED);
  });

  it('초이스쿠폰 자동 변경도 변경이력에 사유와 함께 남는다', async () => {
    const products = {
      1: product(1, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.USE, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, insertedHistories } = createService(products, [{ choiceProductId: 100, productId: 1 }]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.UNUSED } as any);

    const choiceHistory = insertedHistories.find((h) => h.productId === 100);
    expect(choiceHistory).toBeDefined();
    expect(choiceHistory!.key).toBe(ProductUseStatusAutoHistoryKey);
    expect(choiceHistory!.beforeValue).toBe(IProductUseStatus.USE);
    expect(choiceHistory!.afterValue).toBe(IProductUseStatus.UNUSED);
    expect(choiceHistory!.userId).toBe(user.id);
    expect(choiceHistory!.reason).toContain('P1');
  });

  it('초이스쿠폰이 자동 미사용이 되어도 고객상품관리 매핑은 지우지 않는다', async () => {
    // 매핑을 지우면 이후 사용으로 복구돼도 고객사 목록에 다시 노출되지 않는다.
    // 미사용 상품의 노출/집계 제외는 조회 시 useStatus 필터로 처리하므로 매핑은 보존한다.
    const products = {
      1: product(1, IProductUseStatus.USE),
      2: product(2, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.USE, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, userSyncProductEventMappingRepository } = createService(products, [
      { choiceProductId: 100, productId: 1 },
      { choiceProductId: 100, productId: 2 },
    ]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.UNUSED } as any);

    // 자동 미사용된 초이스쿠폰(id: 100)의 매핑은 지우지 않는다.
    // (직접 미사용된 구성상품 id: 1은 기존 경로에서 매핑을 해제하지만, 자동 반영 경로는 매핑을 보존한다.)
    expect(userSyncProductEventMappingRepository.softDelete).not.toHaveBeenCalledWith({ productId: 100 });
  });

  it('매핑은 있는데 구성상품 조회가 누락되면 나머지가 모두 사용이어도 초이스쿠폰은 미사용으로 남는다', async () => {
    const products = {
      1: product(1, IProductUseStatus.USE),
      100: { ...product(100, IProductUseStatus.UNUSED, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, products: after } = createService(products, [
      { choiceProductId: 100, productId: 1 },
      { choiceProductId: 100, productId: 2 },
    ]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.USE } as any);

    expect(after[100].useStatus).toBe(IProductUseStatus.UNUSED);
  });

  it('soft-delete된 구성상품이 있으면 나머지가 모두 사용이어도 초이스쿠폰은 미사용으로 남는다', async () => {
    const products = {
      1: product(1, IProductUseStatus.USE),
      2: { ...product(2, IProductUseStatus.USE), deletedAt: new Date() },
      100: { ...product(100, IProductUseStatus.UNUSED, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, products: after } = createService(products, [
      { choiceProductId: 100, productId: 1 },
      { choiceProductId: 100, productId: 2 },
    ]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.USE } as any);

    expect(after[100].useStatus).toBe(IProductUseStatus.UNUSED);
  });

  it('초이스쿠폰 상태가 이미 목표값이면 저장하지 않는다', async () => {
    const products = {
      1: product(1, IProductUseStatus.USE),
      2: product(2, IProductUseStatus.UNUSED),
      100: { ...product(100, IProductUseStatus.UNUSED, 'CHOICE100'), type: 'CHOICE' },
    };
    const { service, saved } = createService(products, [
      { choiceProductId: 100, productId: 1 },
      { choiceProductId: 100, productId: 2 },
    ]);

    await service.updatePartial(user, { id: 1, useStatus: IProductUseStatus.UNUSED } as any);

    expect(saved.filter((s) => s.id === 100)).toHaveLength(0);
  });

  // 리뷰 지적(High): 삭제 경로에서도 초이스쿠폰 상태를 다시 계산해야 한다.
  describe('delete - 구성상품 삭제 시 초이스쿠폰 동기화', () => {
    it('사용 중인 구성상품이 삭제되면 초이스쿠폰도 미사용이 된다', async () => {
      const products = {
        1: product(1, IProductUseStatus.USE),
        2: product(2, IProductUseStatus.USE),
        100: { ...product(100, IProductUseStatus.USE, 'CHOICE100'), type: 'CHOICE' },
      };
      const { service, products: after } = createService(products, [
        { choiceProductId: 100, productId: 1 },
        { choiceProductId: 100, productId: 2 },
      ]);

      await service.delete(user, { idList: [1] } as any);

      expect(after[100].useStatus).toBe(IProductUseStatus.UNUSED);
    });

    it('삭제로 인한 초이스쿠폰 상태 변경도 자동 이력으로 남는다', async () => {
      const products = {
        1: product(1, IProductUseStatus.USE),
        2: product(2, IProductUseStatus.USE),
        100: { ...product(100, IProductUseStatus.USE, 'CHOICE100'), type: 'CHOICE' },
      };
      const { service, insertedHistories } = createService(products, [
        { choiceProductId: 100, productId: 1 },
        { choiceProductId: 100, productId: 2 },
      ]);

      await service.delete(user, { idList: [1] } as any);

      const choiceHistory = insertedHistories.find((h) => h.productId === 100);
      expect(choiceHistory).toBeDefined();
      expect(choiceHistory!.key).toBe(ProductUseStatusAutoHistoryKey);
      expect(choiceHistory!.afterValue).toBe(IProductUseStatus.UNUSED);
      expect(choiceHistory!.reason).toContain('삭제');
    });

    it('초이스쿠폰에 속하지 않은 상품 삭제는 이력을 남기지 않는다', async () => {
      const products = {
        1: product(1, IProductUseStatus.USE),
        100: { ...product(100, IProductUseStatus.USE, 'CHOICE100'), type: 'CHOICE' },
      };
      const { service, insertedHistories } = createService(products, []);

      await service.delete(user, { idList: [1] } as any);

      expect(insertedHistories).toHaveLength(0);
    });
  });
});
