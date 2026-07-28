import { Repository } from 'typeorm';
import { AutoOrderProductMapper } from './auto.order.product.mapper';
import { ProductEntity } from '../../../entity/product.entity';
import { ProductService } from '../../../product/application/product.service';
import { IProductType } from '../../../product/interface/product.type';
import { IProductUseStatus } from '../../../product/interface/product.status';
import { AutoOrderRunMode, ParsedRow } from './auto.order.types';

/** 최소 ParsedRow 팩토리 */
function row(overrides: Partial<ParsedRow>): ParsedRow {
  return {
    rowNo: 0,
    phone: '010-0000-0000',
    email: null,
    brand: null,
    productName: null,
    productCode: null,
    listPrice: 0,
    amount: 1,
    isValid: true,
    statusReason: 'ok',
    replaceCharacter1: null,
    replaceCharacter2: null,
    replaceCharacter3: null,
    ...overrides,
  };
}

/**
 * code→type 가짜 상품 마스터로 productRepository.find를 흉내.
 * 매퍼가 결과를 Map으로 조회하므로 필터 없이 마스터 전체를 돌려줘도 무해(불필요한 결합 회피).
 */
function fakeRepo(master: Record<string, IProductType>, over: Partial<ProductEntity> = {}): Repository<ProductEntity> {
  return {
    find: async () =>
      Object.entries(master).map(
        ([code, type]) =>
          ({ code, type, price: 5000, useStatus: IProductUseStatus.USE, ...over }) as ProductEntity,
      ),
  } as unknown as Repository<ProductEntity>;
}

/** SSG 액면가 마스터(price→상품) 기반 가짜 ProductService */
function fakeProductService(ssgByPrice: Record<number, Partial<ProductEntity>>, opts?: { createFails?: boolean }) {
  const find = jest.fn(async (price: number) => {
    const p = ssgByPrice[price];
    return p ? ({ id: price, code: `EP-${price}`, type: IProductType.SSG, price, useStatus: IProductUseStatus.USE, ...p } as ProductEntity) : null;
  });
  const create = jest.fn(async (price: number) => {
    if (opts?.createFails) throw new Error('SSG 상품 템플릿을 찾을 수 없습니다.');
    ssgByPrice[price] = ssgByPrice[price] ?? {};
    return (await find(price))!;
  });
  const service = {
    findSsgProductByPriceOrNull: find,
    findOrCreateSsgProductByPrice: create,
  } as unknown as ProductService;
  return { service, find, create };
}

describe('AutoOrderProductMapper', () => {
  const master = {
    'GEN-5000-90': IProductType.GENERAL,
    'SSG-10000-60': IProductType.SSG,
    'REAL-3000': IProductType.REAL,
  };
  const makeMapper = (repo = fakeRepo(master), ssg = fakeProductService({}).service) =>
    new AutoOrderProductMapper(repo, ssg);

  it('5버킷으로 서로소 분할한다', async () => {
    const mapper = makeMapper();
    const rows: ParsedRow[] = [
      row({ rowNo: 5, productCode: 'GEN-5000-90' }), // → general
      row({ rowNo: 6, productCode: 'SSG-10000-60', listPrice: 5000 }), // → ssg (코드 상품 가격과 일치)
      row({ rowNo: 7, productCode: 'REAL-3000' }), // → general(비-SSG)
      row({ rowNo: 8, productCode: '없는코드' }), // → unmapped
      row({ rowNo: 9, productCode: 'GEN-5000-90', isValid: false }), // → excluded
    ];

    const result = await mapper.map(rows, AutoOrderRunMode.COMMIT);

    expect(result.excludedRows.map((r) => r.rowNo)).toEqual([9]);
    expect(result.unmappedRows.map((r) => r.rowNo)).toEqual([8]);
    expect(result.unmappedRows[0].reasonCode).toBe('PRODUCT_CODE_NOT_FOUND');
    expect(result.ssgRows.map((r) => r.rowNo)).toEqual([6]);
    expect(result.generalRows.map((r) => r.rowNo)).toEqual([5, 7]); // GENERAL + REAL
    expect(result.pendingSsgRows).toHaveLength(0);

    // 서로소 합 = 입력 총합 (누락/중복 없음)
    const total =
      result.excludedRows.length +
      result.unmappedRows.length +
      result.pendingSsgRows.length +
      result.generalRows.length +
      result.ssgRows.length;
    expect(total).toBe(rows.length);
  });

  it('_유효=False는 상품코드가 있어도 excluded 우선(무효 표시 존중)', async () => {
    const rows = [row({ rowNo: 5, productCode: 'SSG-10000-60', isValid: false })];
    const result = await makeMapper().map(rows, AutoOrderRunMode.COMMIT);
    expect(result.excludedRows).toHaveLength(1);
    expect(result.ssgRows).toHaveLength(0); // excluded가 우선 → SSG로 안 감
  });

  it('매핑된 행은 product를 함께 들고 온다', async () => {
    const rows = [row({ rowNo: 5, productCode: 'GEN-5000-90' })];
    const result = await makeMapper().map(rows, AutoOrderRunMode.COMMIT);
    expect(result.generalRows[0].product.type).toBe(IProductType.GENERAL);
  });

  // ── 리뷰 반영: 상품코드 없는(blank/null) 유효행은 unmapped, 조회할 코드가 0개면 find 미호출(빈 IN 쿼리 회피)
  it('상품코드 null 유효행 → unmapped, alive 코드 0개면 productRepository.find 미호출', async () => {
    const find = jest.fn(async () => []);
    const m = makeMapper({ find } as unknown as Repository<ProductEntity>);

    const result = await m.map(
      [row({ rowNo: 5, productCode: null }), row({ rowNo: 6, productCode: null })],
      AutoOrderRunMode.COMMIT,
    );

    expect(result.unmappedRows.map((r) => r.rowNo)).toEqual([5, 6]);
    expect(result.generalRows).toHaveLength(0);
    expect(find).not.toHaveBeenCalled();
  });

  // ── SSG 가격 기반 매핑(FE 요청서 2026-07-28 Part C)
  it('SSG 행은 상품코드가 이 서버에 없어도 정상가(I)로 매핑된다', async () => {
    const { service, find } = fakeProductService({ 10000: {} });
    const m = makeMapper(fakeRepo(master), service);

    const result = await m.map(
      [row({ rowNo: 5, brand: '신세계모바일상품권', productName: '신세계 모바일 교환권 10,000원', productCode: 'EP0000000502', listPrice: 10000 })],
      AutoOrderRunMode.COMMIT,
    );

    expect(result.unmappedRows).toHaveLength(0);
    expect(result.ssgRows).toHaveLength(1);
    expect(result.ssgRows[0].product.price).toBe(10000);
    expect(find).toHaveBeenCalledWith(10000);
  });

  it('DRY_RUN은 상품을 생성하지 않고 pendingSsgRows로 분리한다(DB 무변경)', async () => {
    const { service, create } = fakeProductService({});
    const m = makeMapper(fakeRepo(master), service);

    const result = await m.map(
      [row({ rowNo: 5, brand: '신세계모바일상품권', listPrice: 30000 })],
      AutoOrderRunMode.DRY_RUN,
    );

    expect(create).not.toHaveBeenCalled();
    expect(result.pendingSsgRows.map((r) => r.rowNo)).toEqual([5]);
    expect(result.unmappedRows).toHaveLength(0); // 미매핑으로 세지 않는다
  });

  it('COMMIT은 없는 액면가의 SSG 상품을 생성해 매핑한다(액면가별 1회)', async () => {
    const { service, create } = fakeProductService({});
    const m = makeMapper(fakeRepo(master), service);

    const result = await m.map(
      [
        row({ rowNo: 5, brand: '신세계모바일상품권', listPrice: 30000 }),
        row({ rowNo: 6, brand: '신세계모바일상품권', listPrice: 30000 }),
      ],
      AutoOrderRunMode.COMMIT,
    );

    expect(result.ssgRows.map((r) => r.rowNo)).toEqual([5, 6]);
    expect(create).toHaveBeenCalledTimes(1); // 액면가 캐시로 중복 생성 시도 없음
  });

  it('SSG 상품 확보 실패는 SSG_TEMPLATE_MISSING 사유로 미매핑(전체 롤백 아님)', async () => {
    const { service } = fakeProductService({}, { createFails: true });
    const m = makeMapper(fakeRepo(master), service);

    const result = await m.map(
      [row({ rowNo: 5, brand: '신세계모바일상품권', listPrice: 30000 })],
      AutoOrderRunMode.COMMIT,
    );

    expect(result.unmappedRows[0].reasonCode).toBe('SSG_TEMPLATE_MISSING');
  });

  it('SSG인데 정상가(I)를 못 읽으면 SSG_PRICE_MISSING(잘못된 액면가 발송 방지)', async () => {
    const m = makeMapper();
    const result = await m.map(
      [row({ rowNo: 5, brand: '신세계모바일상품권', productCode: '', listPrice: 0 })],
      AutoOrderRunMode.COMMIT,
    );
    expect(result.unmappedRows[0].reasonCode).toBe('SSG_PRICE_MISSING');
  });

  it('코드가 가리키는 SSG 상품의 액면가가 양식과 다르면 가격을 우선한다(서버별 EP 채번 차이)', async () => {
    // 마스터의 SSG-10000-60은 price=5000 → 양식 정상가 10000과 불일치
    const { service, find } = fakeProductService({ 10000: {} });
    const m = makeMapper(fakeRepo(master), service);

    const result = await m.map(
      [row({ rowNo: 5, brand: '신세계모바일상품권', productCode: 'SSG-10000-60', listPrice: 10000 })],
      AutoOrderRunMode.COMMIT,
    );

    expect(find).toHaveBeenCalledWith(10000);
    expect(result.ssgRows[0].product.price).toBe(10000);
  });

  it('SSG 코드가 이 서버에 있어도 정상가(I)가 비면 SSG_PRICE_MISSING(코드 매핑으로 새지 않는다)', async () => {
    // I열 수식 결과가 '행 단위'로 미캐시되면 파일 게이트(FORMULA_NOT_CACHED)에 걸리지 않는다.
    // 그때 코드 매핑으로 빠지면 액면가를 모른 채 그 코드의 상품권이 발송된다 → 반드시 차단.
    const { service, find } = fakeProductService({ 5000: {} });
    const m = makeMapper(fakeRepo(master), service);

    const result = await m.map(
      [row({ rowNo: 5, brand: '신세계모바일상품권', productCode: 'SSG-10000-60', listPrice: 0 })],
      AutoOrderRunMode.COMMIT,
    );

    expect(result.ssgRows).toHaveLength(0);
    expect(result.generalRows).toHaveLength(0);
    expect(result.unmappedRows[0].reasonCode).toBe('SSG_PRICE_MISSING');
    expect(find).not.toHaveBeenCalled(); // 가격을 모르면 조회조차 하지 않는다
  });

  it('판매중지(useStatus !== USE) 상품은 PRODUCT_NOT_SELLABLE로 차단한다', async () => {
    const m = makeMapper(fakeRepo(master, { useStatus: IProductUseStatus.UNUSED }));
    const result = await m.map([row({ rowNo: 5, productCode: 'GEN-5000-90' })], AutoOrderRunMode.COMMIT);

    expect(result.generalRows).toHaveLength(0);
    expect(result.unmappedRows[0].reasonCode).toBe('PRODUCT_NOT_SELLABLE');
  });
});
