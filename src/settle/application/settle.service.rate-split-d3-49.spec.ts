import { SettleService } from './settle.service';

jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: any, _key: string, descriptor: PropertyDescriptor) => descriptor,
  Propagation: { REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSource: jest.fn(),
}));

function makeService(overrides: Record<string, any> = {}): any {
  const svc = Object.create(SettleService.prototype);
  Object.assign(svc, {
    orderRepository: { createQueryBuilder: jest.fn() },
    ...overrides,
  });
  return svc;
}

function makeQb(result: any, isMany = false) {
  const qb: any = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
  };
  if (isMany) qb.getMany = jest.fn().mockResolvedValue(result);
  else qb.getOne = jest.fn().mockResolvedValue(result);
  return qb;
}

/**
 * PR #533(D3-49) 리뷰 코멘트② 대응 B안 — "평균단가를 반올림하는데 이거 맞아요?"
 *
 * 차등정산(SSG 중복할인)은 매핑 안 발송건마다 요율이 달라 단일 단가가 존재하지 않는다.
 * 기존에는 라인총액/수량 평균(반올림)을 단가로 내보내 어느 쿠폰에도 없는 근사값이었고,
 * 프론트가 price*amount 로 합계를 재구성하면 실제 정산액과 어긋날 수 있었다.
 *
 * B안: 요율 적용 단가별로 행을 분리(정산정보입력 화면과 동일 표현) — 모든 행의 단가가
 * 실존값이고 price*amount 가 항상 정확한 합계. 평균·별도 합계 필드가 모두 불필요해진다.
 */
describe('SettleService getUserDetail / getUserDetailMultiple — 요율별 행 분리 (D3-49 코멘트② B안)', () => {
  // 3335원 상품 2건: 발송건1=10% 할인(3001), 발송건2=11% 할인(2968)
  // 기존 평균단가 방식이면 round(5969/2)=2985 단일 행 → 2985*2=5970 ≠ 5969(실제 정산액)
  const mixedRateDeliveries = () => [
    {
      id: 1,
      settleFee: 10,
      settlePriceAdjustment: 'DISCOUNT',
      couponStatus: 'NOT_USED',
      replacedFromId: null,
      actualSendAt: null,
    },
    {
      id: 2,
      settleFee: 11,
      settlePriceAdjustment: 'DISCOUNT',
      couponStatus: 'NOT_USED',
      replacedFromId: null,
      actualSendAt: null,
    },
  ];

  const makeMapping = (orderDeliveries: any[], over: Record<string, unknown> = {}) => ({
    id: 11,
    product: { id: 501, code: 'P501', price: 3335, brand: { nameKorean: '테스트브랜드' } },
    productId: 501,
    amount: 2,
    fee: null,
    priceAdjustment: null,
    orderDeliveries,
    ...over,
  });

  const makeOrder = (id: number, mappings: any[]) => ({
    id,
    userId: 7,
    clientUserId: null,
    user: { id: 7, personName: '테스터', company: null },
    clientUser: null,
    operationUser: null,
    eventName: 'test-event',
    type: 'SSG',
    status: 'DELIVERY_COMPLETE',
    isCreditExcess: false,
    snapshotSettleCondition: 'POST_PAYMENT',
    orderProductMappings: mappings,
  });

  const getDetail = async (order: any) => {
    const svc = makeService({
      orderRepository: { createQueryBuilder: jest.fn().mockReturnValue(makeQb(order)) },
    });
    return svc.getUserDetail({ orderId: order.id });
  };

  it('차등정산 매핑은 요율 적용 단가별로 행 분리 — 모든 행에서 price*amount 가 정확', async () => {
    const res = await getDetail(makeOrder(999, [makeMapping(mixedRateDeliveries())]));
    const products = res.productList.map((row: any) => row.product);

    expect(products).toHaveLength(2); // 10% 행 + 11% 행
    expect(products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ price: 3001, amount: 1 }), // 10%: 3335-round(333.5)=3001 (실존 단가)
        expect.objectContaining({ price: 2968, amount: 1 }), // 11%: 3335-round(366.85)=2968
      ]),
    );
    // 평균단가(2985) 행이 존재하지 않음 + 행 합계가 실제 정산액(5969)과 일치
    expect(products.some((p: any) => p.price === 2985)).toBe(false);
    const total = products.reduce((sum: number, p: any) => sum + p.price * p.amount, 0);
    expect(total).toBe(5969);
    // 분리된 행들은 같은 매핑 id 공유
    expect(res.productList.every((row: any) => row.id === 11)).toBe(true);
  });

  it('균일 요율(비차등) 매핑은 기존과 동일하게 단일 행 (단가 × mapping.amount)', async () => {
    const mapping = makeMapping(
      [
        { id: 1, settleFee: null, settlePriceAdjustment: null, couponStatus: 'NOT_USED', replacedFromId: null },
        { id: 2, settleFee: null, settlePriceAdjustment: null, couponStatus: 'NOT_USED', replacedFromId: null },
      ],
      { fee: 10, priceAdjustment: 'DISCOUNT' },
    );
    const res = await getDetail(makeOrder(999, [mapping]));
    const products = res.productList.map((row: any) => row.product);

    expect(products).toHaveLength(1);
    expect(products[0]).toEqual(expect.objectContaining({ price: 3001, amount: 2 }));
  });

  it('다중 상세: 같은 상품·같은 단가 행은 주문 간 병합, 다른 단가는 분리 유지', async () => {
    const order1 = makeOrder(1001, [makeMapping(mixedRateDeliveries())]);
    const order2 = makeOrder(1002, [makeMapping(mixedRateDeliveries())]);
    const svc = makeService({
      orderRepository: { createQueryBuilder: jest.fn().mockReturnValue(makeQb([order1, order2], true)) },
    });

    const res = await svc.getUserDetailMultipleByBody({ orderIds: [1001, 1002] } as any);

    expect(res.productList).toHaveLength(2); // 상품ID+단가 키: "501-3001", "501-2968"
    expect(res.productList).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ price: 3001, amount: 2 }), // 주문 2개의 10% 발송건 병합
        expect.objectContaining({ price: 2968, amount: 2 }),
      ]),
    );
    // 병합 후에도 price*amount 합계가 실제 정산액(5969×2=11938)과 일치 (평균 방식이면 11940)
    const total = res.productList.reduce((sum: number, p: any) => sum + p.price * p.amount, 0);
    expect(total).toBe(11938);
  });

  it('폐기 후 재발행으로 대체된 CANCEL 원본은 행 분리 집계에서 제외 (이중합산 방지, D3-52 동일 기준)', async () => {
    const deliveries = [
      { id: 1, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'CANCEL', replacedFromId: null },
      { id: 2, settleFee: 11, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'NOT_USED', replacedFromId: null },
      // 재발행분 — bigint hydration 대비 string 참조도 제외되어야 함
      { id: 3, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'NOT_USED', replacedFromId: '1' },
    ];
    const res = await getDetail(makeOrder(999, [makeMapping(deliveries)]));
    const products = res.productList.map((row: any) => row.product);

    // 원본(CANCEL, 대체됨)은 제외 → 10% 행 수량이 2가 아닌 1
    expect(products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ price: 3001, amount: 1 }),
        expect.objectContaining({ price: 2968, amount: 1 }),
      ]),
    );
    expect(products.reduce((sum: number, p: any) => sum + p.price * p.amount, 0)).toBe(5969);
  });

  it('폐기만 하고 재발행하지 않은 CANCEL 은 기존 동작대로 집계 유지 (정산 반영 정책 별도 판단)', async () => {
    const deliveries = [
      { id: 1, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'CANCEL', replacedFromId: null },
      { id: 2, settleFee: 11, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'NOT_USED', replacedFromId: null },
    ];
    const res = await getDetail(makeOrder(999, [makeMapping(deliveries)]));
    const products = res.productList.map((row: any) => row.product);

    expect(products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ price: 3001, amount: 1 }), // 무참조 CANCEL → 유지
        expect.objectContaining({ price: 2968, amount: 1 }),
      ]),
    );
  });
});
