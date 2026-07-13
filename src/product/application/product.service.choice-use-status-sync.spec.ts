jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => undefined,
}));

import { ProductService } from './product.service';
import { IProductUseStatus } from '../interface/product.status';
import { ProductUpdateHistoryEntity } from '../../entity/product.update.history.entity';

// 구성상품 useStatus 변경 시 그 상품을 포함한 초이스쿠폰의 useStatus 동기화 검증.
describe('ProductService.updatePartial - 초이스쿠폰 사용상태 자동 반영', () => {
  const user = { id: 7 } as any;

  // products: id -> { id, code, useStatus, type }
  // mappings: { choiceProductId, productId }[]
  const createService = (products: Record<number, any>, mappings: { choiceProductId: number; productId: number }[]) => {
    const saved: any[] = [];
    const insertedHistories: ProductUpdateHistoryEntity[] = [];

    const productRepository = {
      findOne: jest.fn(async ({ where: { id } }: any) => products[id] ?? null),
      save: jest.fn(async (entity: any) => {
        saved.push({ id: entity.id, useStatus: entity.useStatus });
        products[entity.id] = entity;
        return entity;
      }),
    };

    const productChoiceMappingRepository = {
      find: jest.fn(async ({ where }: any) => {
        if (where.productId !== undefined) {
          return mappings.filter((m) => m.productId === where.productId);
        }
        return mappings
          .filter((m) => m.choiceProductId === where.choiceProductId)
          .map((m) => ({ ...m, product: products[m.productId] }));
      }),
    };

    const productUpdateHistoryRepository = {
      insert: jest.fn(async (rows: ProductUpdateHistoryEntity[]) => insertedHistories.push(...rows)),
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

    return { service, saved, insertedHistories, products };
  };

  const product = (id: number, useStatus: IProductUseStatus, code = `P${id}`) => ({
    id,
    code,
    useStatus,
    type: 'GENERAL',
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

  it('마지막 미사용 구성상품이 복구되면 초이스쿠폰도 사용으로 되돌아온다', async () => {
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

    expect(after[100].useStatus).toBe(IProductUseStatus.USE);
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
    expect(choiceHistory!.key).toBe('useStatus');
    expect(choiceHistory!.beforeValue).toBe(IProductUseStatus.USE);
    expect(choiceHistory!.afterValue).toBe(IProductUseStatus.UNUSED);
    expect(choiceHistory!.userId).toBe(user.id);
    expect(choiceHistory!.reason).toContain('P1');
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
});
