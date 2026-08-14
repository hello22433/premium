import { QueryFailedError } from 'typeorm';
import { ProductService } from './product.service';
import { IProductType } from '../interface/product.type';

/**
 * audit #35 — SSG 상품 동시 생성(예: 생성 버튼 더블클릭) 멱등 처리 회귀 테스트.
 *
 * DB uq_product_ssg_price(price) 위반(ER_DUP_ENTRY) 발생 시,
 * findOrCreateSsgProductByPrice 는 500 이 아니라 먼저 커밋된 row 를 재조회해 반환해야 한다.
 *
 * 생성자 의존성이 많아 Object.create 로 우회 후 협력자만 mock 주입.
 */
describe('ProductService.findOrCreateSsgProductByPrice — 동시 생성 멱등(ER_DUP_ENTRY)', () => {
  const PRICE = 7000;

  const template = {
    partnerCompanyId: 1,
    partnerCompanyCode: 'PC',
    brandId: 2,
    category: 'A',
    classificationId: null,
    settleMethod: 'PER_PRODUCT',
    settlePercent: 10,
    imagePath: 'img',
    couponMethod: 'M',
    memo: null,
    useStatus: 'USE',
    color: null,
    status: null,
    code: 'EP0000000005',
  };
  const latest = { code: 'EP0000000005' };
  const winner = { id: 99, price: PRICE, type: IProductType.SSG } as any;

  const dupError = () => {
    const e = new QueryFailedError('q', [], new Error('dup'));
    (e as QueryFailedError & { code?: string }).code = 'ER_DUP_ENTRY';
    return e;
  };

  // productRepository.createQueryBuilder().getOne() 가 호출 순서대로 큐에서 값을 반환하도록 한다.
  const makeBuilder = (queue: any[]) => {
    const builder: any = {
      innerJoinAndSelect: jest.fn(() => builder),
      leftJoinAndSelect: jest.fn(() => builder),
      where: jest.fn(() => builder),
      andWhere: jest.fn(() => builder),
      orderBy: jest.fn(() => builder),
      getOne: jest.fn(() => Promise.resolve(queue.shift())),
    };
    return builder;
  };

  const makeSut = (productGetOneQueue: any[], saveMock: jest.Mock) => {
    const sut: any = Object.create(ProductService.prototype);
    sut.productRepository = {
      createQueryBuilder: jest.fn(() => makeBuilder(productGetOneQueue)),
      save: saveMock,
    };
    sut.ssgEventRepository = {
      createQueryBuilder: jest.fn(() => makeBuilder([null])),
    };
    return sut;
  };

  it('save 가 ER_DUP_ENTRY 면 먼저 커밋된 row 를 재조회해 반환(멱등)', async () => {
    const save = jest.fn().mockRejectedValue(dupError());
    // 순서: 존재검사(null) → 템플릿 → 채번 latest → (save 실패) → winner 재조회
    const sut = makeSut([null, template, latest, winner], save);

    const result = await sut.findOrCreateSsgProductByPrice(PRICE);

    expect(result).toBe(winner);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('ER_DUP_ENTRY 이나 재조회도 비면(다른 가격 채번 충돌) 그대로 throw → 재시도 자가치유', async () => {
    const save = jest.fn().mockRejectedValue(dupError());
    const sut = makeSut([null, template, latest, null], save);

    await expect(sut.findOrCreateSsgProductByPrice(PRICE)).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('ER_DUP_ENTRY 가 아닌 일반 에러는 멱등 흡수하지 않고 그대로 throw', async () => {
    const save = jest.fn().mockRejectedValue(new Error('connection lost'));
    const sut = makeSut([null, template, latest], save);

    await expect(sut.findOrCreateSsgProductByPrice(PRICE)).rejects.toThrow('connection lost');
  });

  it('신규 SSG 상품은 신세계 모바일 교환권 명칭으로 저장한다', async () => {
    const saved = { id: 100 };
    const reloaded = { id: 100, name: '신세계 모바일 교환권 7,000원' };
    const save = jest.fn().mockResolvedValue(saved);
    const sut = makeSut([null, template, latest, reloaded], save);

    const result = await sut.findOrCreateSsgProductByPrice(PRICE);

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: '신세계 모바일 교환권 7,000원' }));
    expect(result).toBe(reloaded);
  });
});
