import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';

jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: any, _key: string, descriptor: PropertyDescriptor) => descriptor,
  Propagation: { REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSource: jest.fn(),
}));

/**
 * D3-49 리뷰 B안 — 거래명세서(증빙문서)에도 요율별 행 분리 적용.
 *
 * 고객사별정산 상세는 이미 행 분리로 전환됐으나 거래명세서만 "매핑당 1행 + 평균단가(반올림)"가
 * 남아 있었다. 증빙문서에서 unitPrice*quantity !== price 가 되는 건 그 자체로 결함이므로
 * 상세와 동일하게 buildSettlementDisplayLines 로 구성한다.
 *
 * 상품가 3335원, 발송건별 차등정산:
 *   발송건1 = 10% 할인 → 3335 - round(333.5) = 3001
 *   발송건2 = 11% 할인 → 3335 - round(366.85) = 2968
 *   실제 정산액 = 5969
 * 기존 평균단가 방식: round(5969/2) = 2985 단일 행 → 2985*2 = 5970 ≠ 5969 (증빙 불일치)
 */
describe('OrderService getOrderCompleteReport — 요율별 행 분리 (D3-49 B안)', () => {
  const makeDelivery = (over: Record<string, unknown>) => ({
    id: 1,
    settleFee: null,
    settlePriceAdjustment: null,
    couponStatus: 'NOT_USED',
    replacedFromId: null,
    sendRequestAt: null,
    ...over,
  });

  const makeMapping = (orderDeliveries: any[], over: Record<string, unknown> = {}) => ({
    id: 11,
    product: { id: 501, code: 'P501', price: 3335, brand: { nameKorean: '테스트브랜드' } },
    productId: 501,
    amount: 2,
    fee: null,
    priceAdjustment: null,
    sendRequestAt: null,
    snapshotProductPrice: null,
    snapshotProductName: null,
    snapshotProductBrandName: null,
    orderDeliveries,
    ...over,
  });

  const makeOrder = (mappings: any[]) => ({
    id: 100,
    status: IOrderStatus.DELIVERY_COMPLETE,
    createdAt: new Date('2026-01-15T10:00:00'),
    eventName: '테스트이벤트',
    cardSurchargeApplied: false,
    userId: 7,
    clientUserId: null,
    clientUser: null,
    user: { id: 7, personName: '담당자', company: { businessName: '고객사' } },
    orderProductMappings: mappings,
  });

  function makeService(order: any): any {
    const qb: any = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(order),
    };
    const svc = Object.create(OrderService.prototype);
    Object.assign(svc, {
      orderRepository: { createQueryBuilder: jest.fn().mockReturnValue(qb) },
      userRepository: { findOne: jest.fn().mockResolvedValue({ id: 7, companyId: 1, departmentId: null }) },
      userViewScopeRepository: { findOne: jest.fn().mockResolvedValue(null) },
      applyViewScopeFilter: jest.fn((builder: any) => builder),
    });
    return svc;
  }

  const callReport = (order: any) => makeService(order).getOrderCompleteReport({ id: 100 } as any, { id: 7 } as any);

  it('차등정산 매핑은 요율 적용 단가별로 행이 분리되고, 각 행에서 unitPrice*quantity === price', async () => {
    const order = makeOrder([
      makeMapping([
        makeDelivery({ id: 1, settleFee: 10, settlePriceAdjustment: 'DISCOUNT' }),
        makeDelivery({ id: 2, settleFee: 11, settlePriceAdjustment: 'DISCOUNT' }),
      ]),
    ]);

    const res = await callReport(order);

    expect(res.orderDeliveryList).toHaveLength(2);
    expect(res.orderDeliveryList).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unitPrice: 3001, quantity: 1, price: 3001 }),
        expect.objectContaining({ unitPrice: 2968, quantity: 1, price: 2968 }),
      ]),
    );

    // 증빙 정합: 모든 행에서 단가×수량 === 공급가액
    for (const line of res.orderDeliveryList) {
      expect(line.unitPrice * line.quantity).toBe(line.price);
    }

    // 합계는 실제 정산액(발송건별 합)과 정확히 일치 — 평균단가 방식의 5970 이 아니다
    expect(res.price).toBe(5969);
    expect(res.orderDeliveryList.reduce((sum: number, l: any) => sum + l.price, 0)).toBe(res.price);
  });

  it('균일 요율 매핑은 단일 행 유지 (기존 동작)', async () => {
    const order = makeOrder([
      makeMapping(
        [makeDelivery({ id: 1 }), makeDelivery({ id: 2 })],
        { fee: 10, priceAdjustment: 'DISCOUNT' }, // 매핑 레벨 요율, delivery.settleFee 없음
      ),
    ]);

    const res = await callReport(order);

    expect(res.orderDeliveryList).toHaveLength(1);
    expect(res.orderDeliveryList[0]).toEqual(expect.objectContaining({ unitPrice: 3001, quantity: 2, price: 6002 }));
    expect(res.price).toBe(6002);
  });

  it('폐기 후 재발행으로 대체된 CANCEL 원본 발송건은 합계·행에서 제외 (이중합산 방지)', async () => {
    const order = makeOrder([
      makeMapping([
        // 원본: 폐기(CANCEL) 되었고 아래 신행으로 대체됨
        makeDelivery({ id: 1, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'CANCEL' }),
        // 재발행 신행 (replacedFromId = 1)
        makeDelivery({ id: 2, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', replacedFromId: 1 }),
      ]),
    ]);

    const res = await callReport(order);

    expect(res.orderDeliveryList).toHaveLength(1);
    expect(res.orderDeliveryList[0]).toEqual(expect.objectContaining({ unitPrice: 3001, quantity: 1, price: 3001 }));
    expect(res.price).toBe(3001); // 원본까지 세면 6002 가 된다
  });
});
