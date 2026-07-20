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

    return new ProductChoiceService(productRepository as any, {} as any, {} as any, {} as any);
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

  // 리뷰 지적(Medium): 삭제된 구성상품이 조인에서 빠져 정상으로 보이면 안 된다.
  // left join 이므로 삭제된 구성상품은 mapping.product 가 없는 상태로 넘어온다.
  //
  // 아래 세 건은 mapping.product 가 없을 때의 판정 로직만 검증한다.
  // 조인을 left 로 걸었는지 자체는 목이 결과를 주입하므로 여기서 확인되지 않는다.
  // 조인 종류는 product.choice.service.query-sql.spec.ts 가 실제 SQL 로 검증한다.
  it('삭제된 구성상품이 있으면 등록상태를 비정상으로 반환한다', async () => {
    const product = choiceProduct([IProductUseStatus.USE, IProductUseStatus.USE]);
    // 두 번째 구성상품이 삭제돼 조인 결과에 상품이 없다
    product.productChoiceMappings[1] = { product: null } as any;

    const queryBuilder = createQueryBuilder([product]);
    const service = createService(queryBuilder);

    const result = await service.getList({ page: 1, take: 10 } as any);

    expect(result.list[0].registrationStatus).toBe('비정상');
    expect(result.list[0].hasUnusedProduct).toBe(true);
  });

  it('구성상품이 모두 삭제돼도 초이스쿠폰 행은 목록에 남고 비정상으로 표시한다', async () => {
    const product = choiceProduct([IProductUseStatus.USE, IProductUseStatus.USE]);
    product.productChoiceMappings = [{ product: null }, { product: null }] as any;

    const queryBuilder = createQueryBuilder([product]);
    const service = createService(queryBuilder);

    const result = await service.getList({ page: 1, take: 10 } as any);

    expect(result.list).toHaveLength(1);
    expect(result.list[0].registrationStatus).toBe('비정상');
    // productComposition 접근에서 터지지 않아야 한다
    expect(result.list[0].productComposition).toBe('');
  });

  it('구성상품 매핑이 비어 있어도 터지지 않고 비정상으로 표시한다', async () => {
    const product = choiceProduct([]);
    product.productChoiceMappings = [];

    const queryBuilder = createQueryBuilder([product]);
    const service = createService(queryBuilder);

    const result = await service.getList({ page: 1, take: 10 } as any);

    expect(result.list[0].registrationStatus).toBe('비정상');
    expect(result.list[0].productComposition).toBe('');
  });
});
