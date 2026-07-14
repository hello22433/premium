import { resolveLineSnapshot, resolvePartnerSettleSnapshot, assertLineIdsValid } from './order.snapshot.update.helper';

describe('assertLineIdsValid', () => {
  const owned = new Map([
    [10, { productId: 1 }],
    [11, { productId: 2 }],
  ]);
  it('타 주문 id면 400', () => {
    expect(() => assertLineIdsValid([{ id: 99, productId: 1 }] as any, owned as any)).toThrow();
  });
  it('요청 내 중복 id면 400', () => {
    expect(() =>
      assertLineIdsValid(
        [
          { id: 10, productId: 1 },
          { id: 10, productId: 1 },
        ] as any,
        owned as any,
      ),
    ).toThrow();
  });
  it('정상이면 통과', () => {
    expect(() => assertLineIdsValid([{ id: 10, productId: 1 }, { productId: 3 }] as any, owned as any)).not.toThrow();
  });
});

describe('resolveLineSnapshot', () => {
  const snapA = {
    snapshotProductPrice: 1000,
    snapshotProductName: 'A',
    snapshotProductBrandName: 'bA',
    snapshotProductExpireDay: 30,
    snapshotProductImagePath: '/a.png',
  };
  const owned = new Map([[10, { productId: 1, snapshot: snapA }]]);
  const live = { price: 1500, name: 'A2', brand: { nameKorean: 'bA2' }, expireDay: 60, imagePath: '/a2.png' } as any;
  it('동일 id+productId → 기존 snapshot 승계', () => {
    expect(resolveLineSnapshot({ id: 10, productId: 1 } as any, owned as any, live)).toEqual(snapA);
  });
  it('id 있으나 productId 교체 → LIVE 신규 박제', () => {
    expect(resolveLineSnapshot({ id: 10, productId: 9 } as any, owned as any, live).snapshotProductPrice).toBe(1500);
  });
  it('id 없음(신규행) → LIVE 신규 박제', () => {
    expect(resolveLineSnapshot({ productId: 1 } as any, owned as any, live).snapshotProductPrice).toBe(1500);
  });
});

describe('resolvePartnerSettleSnapshot', () => {
  const partnerSnap = {
    partnerSettleFee: 5,
    partnerSettlePriceAdjustment: 'DISCOUNT',
  };
  const owned = new Map([[10, { productId: 1, partnerSettleSnapshot: partnerSnap }]]);
  const live = {
    price: 1500,
    category: 'MOBILE_COUPON',
    classificationId: null,
    brand: null,
    partnerCompany: {
      userDiscounts: [
        {
          category: 'PRODUCT_GROUP',
          method: 'BULK',
          group: 'MOBILE_COUPON',
          pricePercent: 20,
          priceAdjustment: 'DISCOUNT',
        },
      ],
    },
  } as any;

  it('동일 id+productId → 기존 협력사 정산 snapshot 승계', () => {
    expect(resolvePartnerSettleSnapshot({ id: 10, productId: 1 } as any, owned as any, live, 1000)).toEqual(
      partnerSnap,
    );
  });

  it('id 있으나 productId 교체 → LIVE 협력사 조건 신규 박제', () => {
    expect(resolvePartnerSettleSnapshot({ id: 10, productId: 9 } as any, owned as any, live, 1500)).toEqual({
      partnerSettleFee: 20,
      partnerSettlePriceAdjustment: 'DISCOUNT',
    });
  });
});
