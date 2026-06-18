import { ProductChoiceService } from './product.choice.service';
import { IProductUseStatus } from '../../product/interface/product.status';

describe('ProductChoiceService.getList', () => {
  const createQueryBuilder = (products: any[], totalCount = products.length) => {
    const queryBuilder: any = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([products, totalCount]),
    };

    return queryBuilder;
  };

  const createService = (queryBuilder: any) => {
    const productRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    return new ProductChoiceService(productRepository as any, {} as any, {} as any);
  };

  const choiceProduct = (useStatuses: IProductUseStatus[]) => ({
    id: 1,
    createdAt: new Date('2026-06-17T00:00:00.000Z'),
    code: 'CHOICE0001',
    name: '초이스쿠폰',
    useStatus: IProductUseStatus.USE,
    productChoiceMappings: useStatuses.map((useStatus, index) => ({
      product: {
        id: index + 10,
        name: `구성상품${index + 1}`,
        useStatus,
      },
    })),
  });

  it('구성상품이 모두 사용 상태이면 등록상태를 정상으로 반환한다', async () => {
    const queryBuilder = createQueryBuilder([choiceProduct([IProductUseStatus.USE, IProductUseStatus.USE])]);
    const service = createService(queryBuilder);

    const result = await service.getList({ page: 1, take: 10 } as any);

    expect(result.list[0].registrationStatus).toBe('정상');
    expect(result.list[0].hasUnusedProduct).toBe(false);
  });

  it('구성상품 중 미사용 상품이 있으면 등록상태를 비정상으로 반환한다', async () => {
    const queryBuilder = createQueryBuilder([choiceProduct([IProductUseStatus.USE, IProductUseStatus.UNUSED])]);
    const service = createService(queryBuilder);

    const result = await service.getList({ page: 1, take: 10 } as any);

    expect(result.list[0].registrationStatus).toBe('비정상');
    expect(result.list[0].hasUnusedProduct).toBe(true);
  });

  it('구성상품 중 영구 미사용 상품이 있으면 등록상태를 비정상으로 반환한다', async () => {
    const queryBuilder = createQueryBuilder([
      choiceProduct([IProductUseStatus.USE, IProductUseStatus.PERMANENTLY_UNUSED]),
    ]);
    const service = createService(queryBuilder);

    const result = await service.getList({ page: 1, take: 10 } as any);

    expect(result.list[0].registrationStatus).toBe('비정상');
    expect(result.list[0].hasUnusedProduct).toBe(true);
  });
});
