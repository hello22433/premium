import { SettleService } from './settle.service';

jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: any, _key: string, descriptor: PropertyDescriptor) => descriptor,
  Propagation: { REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSource: jest.fn(),
}));

/**
 * D3-49 리뷰(테스트 갭 A/B/D) — getUserList / getUserIds / getUserSummary 합산 회귀.
 *
 * 세 경로 모두 order.orderProductMappings 를 순회하며 calculateMappingSettlementBaseAmount(mapping)
 * 로 정산액을 합산한다. getUserDetail 은 rate-split spec 으로, getUserSummary 는 DB 통합테스트로
 * 커버돼 있었지만 list/ids 는 무커버였다(같은 합산인데 한쪽만 회귀해도 green).
 *
 * 차등정산(발송건별 settleFee)이 반영돼야 목록 합계와 요약 footer 가 일치한다:
 *   3335원 상품 2건 = 10% 할인(3001) + 11% 할인(2968) = 5969
 *   settleFee 를 무시(정가 균일)하면 3335×2 = 6670 → 목록≠요약 불일치.
 */
describe('SettleService getUserList / getUserIds / getUserSummary — settleFee 합산 (D3-49 리뷰 A/B/D)', () => {
  const mixedRateDeliveries = () => [
    { id: 1, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'NOT_USED', replacedFromId: null, actualSendAt: null },
    { id: 2, settleFee: 11, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'NOT_USED', replacedFromId: null, actualSendAt: null },
  ];

  const makeMapping = (orderDeliveries: any[], over: Record<string, unknown> = {}) => ({
    id: 11,
    product: { id: 501, code: 'P501', name: '테스트상품', price: 3335, brand: { nameKorean: '테스트브랜드' } },
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
    user: { id: 7, personName: '테스터', company: null, companyId: 3 },
    clientUser: null,
    operationUser: null,
    eventName: 'test-event',
    type: 'SSG',
    status: 'DELIVERY_COMPLETE',
    isCreditExcess: false,
    snapshotSettleCondition: 'POST_PAYMENT',
    registerAt: new Date('2026-01-01T00:00:00+09:00'),
    sendAmount: 6670,
    settleAmount: 5969,
    deliveryCompleteReportCount: 0,
    deliveryReportLastSource: null,
    orderCompleteReportCount: 0,
    transactionStatementLastSource: null,
    orderProductMappings: mappings,
  });

  // buildUserSettleQueryBuilder 를 스텁해 쿼리 구성은 우회하고 합산 로직만 격리한다.
  // (list=getManyAndCount, ids/summary=getMany 를 모두 지원하는 QB 스텁)
  function makeService(orders: any[]): any {
    const qb = {
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([orders, orders.length]),
      getMany: jest.fn().mockResolvedValue(orders),
    };
    const svc = Object.create(SettleService.prototype);
    svc.buildUserSettleQueryBuilder = jest.fn().mockReturnValue(qb);
    return svc;
  }

  const baseQuery = { startAt: '2000-01-01', endAt: '2100-12-31', page: 1, take: 20 };

  it('getUserList: settlePrice 가 발송건별 settleFee 를 반영(5969) — 정가 균일(6670) 아님', async () => {
    const svc = makeService([makeOrder(1001, [makeMapping(mixedRateDeliveries())])]);

    const res = await svc.getUserList(baseQuery);

    expect(res.list).toHaveLength(1);
    expect(res.list[0].settlePrice).toBe(5969);
    expect(res.list[0].settlePrice).not.toBe(6670);
    // originalSettlePrice(order.settleAmount)와 정산 재계산이 일치
    expect(res.list[0].originalSettlePrice).toBe(5969);
  });

  it('getUserIds: settlePrice 합산이 list 와 동일(5969)', async () => {
    const svc = makeService([makeOrder(1001, [makeMapping(mixedRateDeliveries())])]);

    const res = await svc.getUserIds(baseQuery);

    expect(res.items).toHaveLength(1);
    expect(res.items[0].settlePrice).toBe(5969);
    expect(res.items[0].settlePrice).not.toBe(6670);
  });

  it('getUserSummary: totalSettlePriceSum 이 list/ids 와 동일(5969), totalDeliveryPriceSum 은 발송금액(6670)', async () => {
    const svc = makeService([makeOrder(1001, [makeMapping(mixedRateDeliveries())])]);

    const res = await svc.getUserSummary(baseQuery);

    expect(res.totalSettlePriceSum).toBe(5969);
    expect(res.totalSettlePriceSum).not.toBe(6670);
    expect(res.totalDeliveryPriceSum).toBe(6670);
  });

  it('불변식: 동일 주문에서 list.settlePrice === ids.settlePrice === summary.totalSettlePriceSum', async () => {
    const orders = () => [makeOrder(1001, [makeMapping(mixedRateDeliveries())])];

    const list = await makeService(orders()).getUserList(baseQuery);
    const ids = await makeService(orders()).getUserIds(baseQuery);
    const summary = await makeService(orders()).getUserSummary(baseQuery);

    const listSum = list.list.reduce((s: number, r: any) => s + r.settlePrice, 0);
    const idsSum = ids.items.reduce((s: number, r: any) => s + r.settlePrice, 0);

    expect(listSum).toBe(idsSum);
    expect(idsSum).toBe(summary.totalSettlePriceSum);
    expect(summary.totalSettlePriceSum).toBe(5969);
  });

  it('폐기 후 재발행 CANCEL 원본은 세 경로 모두에서 제외 (이중합산 방지, D3-52 동일 기준)', async () => {
    // 원본(10%, CANCEL, 대체됨) + 생존(11%) + 재발행(10%, replacedFromId=원본). 원본 제외 → 3001+2968=5969
    const deliveries = [
      { id: 1, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'CANCEL', replacedFromId: null, actualSendAt: null },
      { id: 2, settleFee: 11, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'NOT_USED', replacedFromId: null, actualSendAt: null },
      { id: 3, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'NOT_USED', replacedFromId: '1', actualSendAt: null },
    ];
    const orders = () => [makeOrder(1001, [makeMapping(deliveries)])];

    const list = await makeService(orders()).getUserList(baseQuery);
    const summary = await makeService(orders()).getUserSummary(baseQuery);

    expect(list.list[0].settlePrice).toBe(5969);
    expect(summary.totalSettlePriceSum).toBe(5969);
  });
});
