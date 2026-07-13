jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => undefined,
}));

import { ProductChoiceService } from './product.choice.service';
import { IProductUseStatus } from '../../product/interface/product.status';

// 초이스쿠폰 등록/수정 시 구성상품 상태에 따라 useStatus 를 보정하는지 검증.
// (구성상품 교체는 구성상품 useStatus 를 바꾸지 않으므로 ProductService cascade 가 돌지 않는다)
describe('ProductChoiceService - 구성상품 상태에 따른 초이스쿠폰 useStatus 보정', () => {
  const component = (id: number, useStatus: IProductUseStatus) => ({
    id,
    price: 1000,
    imagePath: 'img.png',
    useStatus,
  });

  const createService = (components: any[]) => {
    const created: any[] = [];
    const updated: any[] = [];

    const productRepository = {
      find: jest.fn(async () => components),
      findOne: jest.fn(async () => ({ id: 100, type: 'CHOICE' })),
      create: jest.fn((entity: any) => {
        created.push(entity);
        return entity;
      }),
      save: jest.fn(async (entity: any) => ({ ...entity, id: 100 })),
      update: jest.fn(async (_id: number, patch: any) => {
        updated.push(patch);
      }),
    };

    const productChoiceMappingRepository = {
      create: jest.fn((entity: any) => entity),
      insert: jest.fn(),
      softDelete: jest.fn(),
    };

    const service = new ProductChoiceService(
      productRepository as any,
      productChoiceMappingRepository as any,
      {} as any,
    );

    return { service, created, updated };
  };

  const body = (useStatus: IProductUseStatus) => ({
    name: '초이스쿠폰',
    imagePath: 'img.png',
    productIdList: [1, 2],
    useStatus,
  });

  describe('create', () => {
    it('구성상품이 모두 사용이면 요청대로 사용으로 등록한다', async () => {
      const { service, created } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.create(body(IProductUseStatus.USE) as any);

      expect(created[0].useStatus).toBe(IProductUseStatus.USE);
    });

    it('미사용 구성상품이 있으면 사용으로 요청해도 미사용으로 등록한다', async () => {
      const { service, created } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.UNUSED),
      ]);

      await service.create(body(IProductUseStatus.USE) as any);

      expect(created[0].useStatus).toBe(IProductUseStatus.UNUSED);
    });

    it('영구미사용 구성상품이 있어도 초이스쿠폰은 미사용으로 등록한다', async () => {
      const { service, created } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.PERMANENTLY_UNUSED),
      ]);

      await service.create(body(IProductUseStatus.USE) as any);

      expect(created[0].useStatus).toBe(IProductUseStatus.UNUSED);
    });

    it('구성상품이 모두 정상이어도 미사용 요청은 존중한다', async () => {
      const { service, created } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.create(body(IProductUseStatus.UNUSED) as any);

      expect(created[0].useStatus).toBe(IProductUseStatus.UNUSED);
    });
  });

  describe('update', () => {
    it('구성상품 교체로 미사용 상품이 들어오면 미사용으로 수정한다', async () => {
      const { service, updated } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.UNUSED),
      ]);

      await service.update({ id: 100, ...body(IProductUseStatus.USE) } as any);

      expect(updated[0].useStatus).toBe(IProductUseStatus.UNUSED);
    });

    it('구성상품 교체로 미사용 상품이 빠지면 사용으로 되돌린다', async () => {
      const { service, updated } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.update({ id: 100, ...body(IProductUseStatus.USE) } as any);

      expect(updated[0].useStatus).toBe(IProductUseStatus.USE);
    });

    it('구성상품이 모두 정상이어도 미사용 요청은 존중한다', async () => {
      const { service, updated } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.update({ id: 100, ...body(IProductUseStatus.UNUSED) } as any);

      expect(updated[0].useStatus).toBe(IProductUseStatus.UNUSED);
    });
  });
});
