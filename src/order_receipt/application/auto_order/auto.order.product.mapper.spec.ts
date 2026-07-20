import { Repository } from 'typeorm';
import { AutoOrderProductMapper } from './auto.order.product.mapper';
import { ProductEntity } from '../../../entity/product.entity';
import { IProductType } from '../../../product/interface/product.type';
import { ParsedRow } from './auto.order.types';

/** 최소 ParsedRow 팩토리 */
function row(overrides: Partial<ParsedRow>): ParsedRow {
  return {
    rowNo: 0,
    phone: '010-0000-0000',
    email: null,
    productCode: null,
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
function fakeRepo(master: Record<string, IProductType>): Repository<ProductEntity> {
  return {
    find: async () =>
      Object.entries(master).map(([code, type]) => ({ code, type, price: 5000 }) as ProductEntity),
  } as unknown as Repository<ProductEntity>;
}

describe('AutoOrderProductMapper', () => {
  const master = {
    'GEN-5000-90': IProductType.GENERAL,
    'SSG-10000-60': IProductType.SSG,
    'REAL-3000': IProductType.REAL,
  };
  const mapper = new AutoOrderProductMapper(fakeRepo(master));

  it('4버킷으로 서로소 분할한다', async () => {
    const rows: ParsedRow[] = [
      row({ rowNo: 5, productCode: 'GEN-5000-90' }), // → general
      row({ rowNo: 6, productCode: 'SSG-10000-60' }), // → ssg
      row({ rowNo: 7, productCode: 'REAL-3000' }), // → general(비-SSG)
      row({ rowNo: 8, productCode: '없는코드' }), // → unmapped
      row({ rowNo: 9, productCode: 'GEN-5000-90', isValid: false }), // → excluded
    ];

    const result = await mapper.map(rows);

    expect(result.excludedRows.map((r) => r.rowNo)).toEqual([9]);
    expect(result.unmappedRows.map((r) => r.rowNo)).toEqual([8]);
    expect(result.ssgRows.map((r) => r.rowNo)).toEqual([6]);
    expect(result.generalRows.map((r) => r.rowNo)).toEqual([5, 7]); // GENERAL + REAL

    // 서로소 합 = 입력 총합 (누락/중복 없음)
    const total =
      result.excludedRows.length +
      result.unmappedRows.length +
      result.generalRows.length +
      result.ssgRows.length;
    expect(total).toBe(rows.length);
  });

  it('_유효=False는 상품코드가 있어도 excluded 우선(무효 표시 존중)', async () => {
    const rows = [row({ rowNo: 5, productCode: 'SSG-10000-60', isValid: false })];
    const result = await mapper.map(rows);
    expect(result.excludedRows).toHaveLength(1);
    expect(result.ssgRows).toHaveLength(0); // excluded가 우선 → SSG로 안 감
  });

  it('매핑된 행은 product를 함께 들고 온다', async () => {
    const rows = [row({ rowNo: 5, productCode: 'GEN-5000-90' })];
    const result = await mapper.map(rows);
    expect(result.generalRows[0].product.type).toBe(IProductType.GENERAL);
  });

  // ── 리뷰 반영: 상품코드 없는(blank/null) 유효행은 unmapped, 조회할 코드가 0개면 find 미호출(빈 IN 쿼리 회피)
  it('상품코드 null 유효행 → unmapped, alive 코드 0개면 productRepository.find 미호출', async () => {
    const find = jest.fn(async () => []);
    const m = new AutoOrderProductMapper({ find } as unknown as Repository<ProductEntity>);

    const result = await m.map([row({ rowNo: 5, productCode: null }), row({ rowNo: 6, productCode: null })]);

    expect(result.unmappedRows.map((r) => r.rowNo)).toEqual([5, 6]);
    expect(result.generalRows).toHaveLength(0);
    expect(find).not.toHaveBeenCalled();
  });
});
