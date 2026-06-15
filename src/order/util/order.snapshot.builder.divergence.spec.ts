import { buildPriceDivergence } from './order.snapshot.builder';

describe('buildPriceDivergence', () => {
  it('snapshot≠현재가 → changed true', () => {
    expect(buildPriceDivergence({ snapshotProductPrice: 1000, product: { price: 1500 } } as any))
      .toEqual({ priceChanged: true, snapshotPrice: 1000, currentPrice: 1500 });
  });
  it('동일가 → changed false', () => {
    expect(buildPriceDivergence({ snapshotProductPrice: 1500, product: { price: 1500 } } as any))
      .toEqual({ priceChanged: false, snapshotPrice: 1500, currentPrice: 1500 });
  });
  it('legacy snapshot NULL → changed false', () => {
    expect(buildPriceDivergence({ snapshotProductPrice: null, product: { price: 1500 } } as any))
      .toEqual({ priceChanged: false, snapshotPrice: null, currentPrice: 1500 });
  });
  it('삭제상품 → currentPrice null, changed false', () => {
    expect(buildPriceDivergence({ snapshotProductPrice: 1000, product: null } as any))
      .toEqual({ priceChanged: false, snapshotPrice: 1000, currentPrice: null });
  });
});
