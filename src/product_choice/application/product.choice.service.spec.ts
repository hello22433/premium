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

// 리뷰 지적(Medium): 상세 조회도 매핑을 left join 으로 유지하고
// 삭제된 구성상품을 표시하거나 비정상 상태로 반환해야 한다.
//
// 아래 검증은 조회 결과가 주어졌을 때의 매핑/판정 로직만 본다.
// 조인 종류와 withDeleted 여부는 목이 결과를 주입해 여기서 확인되지 않으므로
// product.choice.service.query-sql.spec.ts 가 실제 SQL 로 검증한다.
describe('ProductChoiceService.getDetail', () => {
  const createService = (productChoice: any) => {
    const queryBuilder: any = {
      withDeleted: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(productChoice),
    };

    const productRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    return new ProductChoiceService(productRepository as any, {} as any, {} as any, {} as any);
  };

  const component = (overrides: Record<string, any> = {}) => ({
    id: 10,
    createdAt: new Date('2026-06-17T00:00:00.000Z'),
    code: 'PROD0001',
    classification: { classification: '대분류' },
    brandId: 3,
    brand: { nameKorean: '브랜드' },
    name: '구성상품',
    price: 5000,
    expireDay: 90,
    category: 'A',
    useStatus: IProductUseStatus.USE,
    deletedAt: null,
    ...overrides,
  });

  const choiceDetail = (components: any[]) => ({
    id: 1,
    code: 'CHOICE0001',
    name: '초이스쿠폰',
    price: 5000,
    imagePath: '/image.png',
    useStatus: IProductUseStatus.USE,
    productChoiceMappings: components.map((product, index) => ({
      productId: product?.id ?? index + 10,
      product,
    })),
  });

  it('구성상품이 모두 정상이면 hasUnusedProduct 를 false 로 반환한다', async () => {
    const service = createService(choiceDetail([component(), component({ id: 11 })]));

    const result = await service.getDetail({ id: 1 } as any);

    expect(result.hasUnusedProduct).toBe(false);
    expect(result.productList.every((product) => product.isDeleted)).toBe(false);
  });

  // 기존 동작: inner join 이라 삭제된 구성상품이 조인에서 빠져 남은 상품만 보였다.
  // 관리자 눈에는 이유 없이 미사용인 쿠폰으로 보인다.
  it('삭제된 구성상품도 목록에 남기고 isDeleted 로 표시한다', async () => {
    const deleted = component({ id: 11, code: 'PROD0002', name: '삭제된상품', deletedAt: new Date() });
    const service = createService(choiceDetail([component(), deleted]));

    const result = await service.getDetail({ id: 1 } as any);

    expect(result.productList).toHaveLength(2);
    expect(result.productList[1].isDeleted).toBe(true);
    expect(result.productList[1].useStatus).toBeNull();
    // 교체 대상을 특정할 수 있어야 하므로 코드와 상품명은 그대로 남긴다
    expect(result.productList[1].code).toBe('PROD0002');
    expect(result.productList[1].name).toBe('삭제된상품');
    // 조인이 비는 필드는 빈 값으로 내린다
    expect(result.productList[1].brandName).toBe('');
    expect(result.productList[1].classification).toBe('');
  });

  it('삭제된 구성상품이 있으면 hasUnusedProduct 를 true 로 반환한다', async () => {
    const deleted = component({ id: 11, deletedAt: new Date() });
    const service = createService(choiceDetail([component(), deleted]));

    const result = await service.getDetail({ id: 1 } as any);

    expect(result.hasUnusedProduct).toBe(true);
  });

  // 기존 동작: 구성상품이 전부 삭제되면 inner join 탓에 getOne 이 null 을 반환해
  // 실제로 존재하는 초이스쿠폰에 "존재하지 않는 초이스쿠폰입니다" 가 떴다.
  it('구성상품이 모두 삭제돼도 상세를 반환하고 비정상으로 표시한다', async () => {
    const service = createService(
      choiceDetail([component({ deletedAt: new Date() }), component({ id: 11, deletedAt: new Date() })]),
    );

    const result = await service.getDetail({ id: 1 } as any);

    expect(result.id).toBe(1);
    expect(result.productList).toHaveLength(2);
    expect(result.productList.every((product) => product.isDeleted)).toBe(true);
    expect(result.hasUnusedProduct).toBe(true);
  });

  // 매핑만 남고 상품 행 자체를 못 읽은 경우다.
  // 기존 매퍼는 product.id 접근에서 터졌다.
  it('매핑에 상품이 없어도 터지지 않고 isDeleted 로 표시한다', async () => {
    const service = createService(choiceDetail([component(), null]));

    const result = await service.getDetail({ id: 1 } as any);

    expect(result.productList[1].isDeleted).toBe(true);
    // 상품 행이 없으면 매핑의 productId 로 대체한다
    expect(result.productList[1].id).toBe(11);
    expect(result.hasUnusedProduct).toBe(true);
  });

  it('구성상품 중 미사용 상품이 있으면 hasUnusedProduct 를 true 로 반환한다', async () => {
    const service = createService(
      choiceDetail([component(), component({ id: 11, useStatus: IProductUseStatus.UNUSED })]),
    );

    const result = await service.getDetail({ id: 1 } as any);

    expect(result.hasUnusedProduct).toBe(true);
    // 미사용은 삭제와 구분되어야 한다
    expect(result.productList[1].isDeleted).toBe(false);
    expect(result.productList[1].useStatus).toBe(IProductUseStatus.UNUSED);
  });

  it('존재하지 않는 초이스쿠폰이면 예외를 던진다', async () => {
    const service = createService(null);

    await expect(service.getDetail({ id: 999 } as any)).rejects.toThrow('존재하지 않는 초이스쿠폰입니다.');
  });
});

describe('ProductChoiceService.getProductList', () => {
  const createQueryBuilder = (products: any[], totalCount = products.length) => {
    const queryBuilder: any = {
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

  const searchProduct = (id: number) => ({
    id,
    createdAt: new Date('2026-06-17T00:00:00.000Z'),
    code: `EP${id}`,
    brandId: 1,
    brand: { nameKorean: '브랜드' },
    name: `상품${id}`,
    price: 5000,
    expireDay: 60,
    category: 'D',
    useStatus: IProductUseStatus.USE,
  });

  const excludeConditions = (queryBuilder: any): string[] =>
    queryBuilder.andWhere.mock.calls
      .map(([condition]: any[]) => String(condition))
      .filter((condition: string) => condition.includes('NOT IN'));

  it('제외 목록을 넘기지 않으면 제외 조건을 붙이지 않는다', async () => {
    const queryBuilder = createQueryBuilder([searchProduct(780)]);
    const service = createService(queryBuilder);

    await service.getProductList({ page: 1, take: 10 } as any);

    expect(excludeConditions(queryBuilder)).toHaveLength(0);
  });

  it('제외 목록이 빈 배열이면 제외 조건을 붙이지 않는다', async () => {
    // 빈 배열을 그대로 넘기면 `IN ()` 이 되어 SQL 문법 에러가 난다. (신규 등록 화면이 이 케이스)
    const queryBuilder = createQueryBuilder([searchProduct(780)]);
    const service = createService(queryBuilder);

    await service.getProductList({ page: 1, take: 10, excludeProductIdList: [] } as any);

    expect(excludeConditions(queryBuilder)).toHaveLength(0);
  });

  it('제외 목록이 있으면 NOT IN 조건과 파라미터를 함께 넘긴다', async () => {
    const queryBuilder = createQueryBuilder([searchProduct(780)]);
    const service = createService(queryBuilder);

    await service.getProductList({ page: 1, take: 10, excludeProductIdList: [763, 729] } as any);

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('product.id NOT IN (:...excludeProductIdList)', {
      excludeProductIdList: [763, 729],
    });
  });

  it('getManyAndCount 가 돌려준 totalCount 로 totalPage 를 올림 계산한다', async () => {
    // 제외가 totalCount 에 반영되는지는 목이 아니라 실제 DB 로만 증명된다(로컬 HTTP 검증에서 확인).
    // 여기서는 count → totalPage 산술만 고정한다.
    const queryBuilder = createQueryBuilder([searchProduct(780)], 25);
    const service = createService(queryBuilder);

    const result = await service.getProductList({ page: 1, take: 10 } as any);

    expect(result.totalCount).toBe(25);
    expect(result.totalPage).toBe(3);
  });
});
