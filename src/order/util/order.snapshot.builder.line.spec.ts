import { buildLineProductSnapshot, readLineProductView } from './order.snapshot.builder';

const product = (over: any = {}) => ({
  id: 1, name: '상품A', price: 1000, expireDay: 30, imagePath: '/img/a.png',
  brand: { nameKorean: '브랜드A' }, ...over,
}) as any;

describe('buildLineProductSnapshot', () => {
  it('LIVE product에서 5필드 박제', () => {
    expect(buildLineProductSnapshot(product())).toEqual({
      snapshotProductPrice: 1000,
      snapshotProductName: '상품A',
      snapshotProductBrandName: '브랜드A',
      snapshotProductExpireDay: 30,
      snapshotProductImagePath: '/img/a.png',
    });
  });
  it('brand 없으면 브랜드명 빈문자', () => {
    expect(buildLineProductSnapshot(product({ brand: null })).snapshotProductBrandName).toBe('');
  });
});

describe('readLineProductView', () => {
  it('snapshot 있으면 snapshot 우선', () => {
    const opm = { snapshotProductPrice: 1000, snapshotProductName: '구상품', snapshotProductBrandName: '구브랜드',
      snapshotProductExpireDay: 30, snapshotProductImagePath: '/old.png',
      product: { name: '신상품', price: 1500, expireDay: 60, imagePath: '/new.png', brand: { nameKorean: '신브랜드' } } } as any;
    expect(readLineProductView(opm)).toEqual({
      name: '구상품', price: 1000, brandName: '구브랜드', expireDay: 30, imagePath: '/old.png',
    });
  });
  it('legacy snapshot NULL이면 LIVE fallback', () => {
    const opm = { snapshotProductPrice: null, snapshotProductName: null, snapshotProductBrandName: null,
      snapshotProductExpireDay: null, snapshotProductImagePath: null,
      product: { name: '신상품', price: 1500, expireDay: 60, imagePath: '/new.png', brand: { nameKorean: '신브랜드' } } } as any;
    expect(readLineProductView(opm)).toEqual({
      name: '신상품', price: 1500, brandName: '신브랜드', expireDay: 60, imagePath: '/new.png',
    });
  });
  it('삭제상품(product null)이면 안전 기본값', () => {
    const opm = { snapshotProductPrice: null, snapshotProductName: null, snapshotProductBrandName: null,
      snapshotProductExpireDay: null, snapshotProductImagePath: null, product: null } as any;
    expect(readLineProductView(opm)).toEqual({
      name: '(삭제된 상품)', price: 0, brandName: '', expireDay: 0, imagePath: null,
    });
  });
});
