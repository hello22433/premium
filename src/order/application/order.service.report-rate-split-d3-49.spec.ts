import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { calculateOrderSettlementAmount } from '../../util/settle-fee.util';

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

  /**
   * 증빙문서의 두 정합 조건을 한 번에 검사한다.
   *  (1) 문서 내부 정합: 모든 행에서 unitPrice * quantity === price (평균단가면 깨진다)
   *  (2) 원장 정합: 행 합계 === 실제 정산액(calculateOrderSettlementAmount, 카드할증 제외 base)
   * (2)가 핵심이다 — 표시(buildSettlementDisplayLines)와 돈(calculateMappingSettlementBaseAmount)이
   * 서로 다른 기준을 쓰면 여기서 깨진다. D3-52(재발행 이중합산 방지)가 돈 경로에도 동일 필터를
   * 적용한 덕에 재발행 케이스에서도 성립한다.
   */
  const expectReportIsConsistent = (res: any, order: any) => {
    for (const line of res.orderDeliveryList) {
      expect(line.unitPrice * line.quantity).toBe(line.price);
    }
    const rowSum = res.orderDeliveryList.reduce((sum: number, l: any) => sum + l.price, 0);
    expect(rowSum).toBe(res.price);
    expect(rowSum).toBe(calculateOrderSettlementAmount(order, false));
  };

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

    // 합계는 실제 정산액과 정확히 일치 — 평균단가 방식의 5970 이 아니다
    expect(res.price).toBe(5969);
    expectReportIsConsistent(res, order);
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
    expectReportIsConsistent(res, order);
  });

  it('폐기 후 재발행으로 대체된 CANCEL 원본은 행·합계에서 제외되고, 실제 정산액과도 일치 (D3-52)', async () => {
    const order = makeOrder([
      makeMapping([
        // 원본: 폐기(CANCEL) 되었고 아래 신행으로 대체됨
        makeDelivery({ id: 1, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', couponStatus: 'CANCEL' }),
        // 재발행 신행 (replacedFromId = 1, settleFee 승계)
        makeDelivery({ id: 2, settleFee: 10, settlePriceAdjustment: 'DISCOUNT', replacedFromId: 1 }),
      ]),
    ]);

    const res = await callReport(order);

    expect(res.orderDeliveryList).toHaveLength(1);
    expect(res.orderDeliveryList[0]).toEqual(expect.objectContaining({ unitPrice: 3001, quantity: 1, price: 3001 }));
    // 원본까지 세면 6002. 표시(3001)와 실제 정산액이 함께 3001 이어야 한다 —
    // D3-52 이전에는 돈 경로만 6002 라 증빙문서가 원장과 어긋났다.
    expect(res.price).toBe(3001);
    expectReportIsConsistent(res, order);
  });

  it('다중 매핑(상품 여러 줄) 합계 누적 — price = total 로 덮어쓰는 회귀 방지', async () => {
    const order = makeOrder([
      makeMapping([makeDelivery({ id: 1 }), makeDelivery({ id: 2 })], { fee: 10, priceAdjustment: 'DISCOUNT' }),
      makeMapping(
        [makeDelivery({ id: 3, settleFee: 11, settlePriceAdjustment: 'DISCOUNT' })],
        { id: 12, amount: 1 }, // 두 번째 상품줄 (차등)
      ),
    ]);

    const res = await callReport(order);

    expect(res.orderDeliveryList).toHaveLength(2); // 균일 1행 + 차등 1행
    expect(res.price).toBe(6002 + 2968);
    expectReportIsConsistent(res, order);
  });
});

describe('OrderService getOrderCompleteReportMultiple — 요율별 행 분리 + 주문 간 합계 누적 (D3-49 B안)', () => {
  const makeDelivery = (over: Record<string, unknown>) => ({
    id: 1,
    settleFee: null,
    settlePriceAdjustment: null,
    couponStatus: 'NOT_USED',
    replacedFromId: null,
    sendRequestAt: new Date('2026-01-10T09:00:00'),
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

  const makeOrder = (id: number, mappings: any[]) => ({
    id,
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

  function makeService(orders: any[]): any {
    const qb: any = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(orders),
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

  it('차등 주문 + 균일 주문 → 행이 요율별로 분리되고 price 는 두 주문 합', async () => {
    const diffOrder = makeOrder(100, [
      makeMapping([
        makeDelivery({ id: 1, settleFee: 10, settlePriceAdjustment: 'DISCOUNT' }),
        makeDelivery({ id: 2, settleFee: 11, settlePriceAdjustment: 'DISCOUNT' }),
      ]),
    ]);
    const uniformOrder = makeOrder(101, [
      makeMapping([makeDelivery({ id: 3 }), makeDelivery({ id: 4 })], { id: 12, fee: 10, priceAdjustment: 'DISCOUNT' }),
    ]);

    const res = await makeService([diffOrder, uniformOrder]).getOrderCompleteReportMultiple('100,101', undefined, {
      id: 7,
    } as any);

    // 차등 주문 2행(3001/2968) + 균일 주문 1행(3001×2)
    expect(res.orderDeliveryList).toHaveLength(3);
    for (const line of res.orderDeliveryList) {
      expect(line.unitPrice * line.quantity).toBe(line.price);
    }

    // 주문 간 합계 누적: 5969 + 6002
    expect(res.price).toBe(5969 + 6002);
    expect(res.orderDeliveryList.reduce((sum: number, l: any) => sum + l.price, 0)).toBe(res.price);

    // 원장 정합: 각 주문의 실제 정산액 합과 일치
    expect(res.price).toBe(
      calculateOrderSettlementAmount(diffOrder as any, false) +
        calculateOrderSettlementAmount(uniformOrder as any, false),
    );
  });

  it('증빙일자(evidenceDate)를 주면 분리된 모든 행의 일자가 증빙일자로 통일된다', async () => {
    const order = makeOrder(100, [
      makeMapping([
        makeDelivery({ id: 1, settleFee: 10, settlePriceAdjustment: 'DISCOUNT' }),
        makeDelivery({ id: 2, settleFee: 11, settlePriceAdjustment: 'DISCOUNT' }),
      ]),
    ]);

    const res = await makeService([order]).getOrderCompleteReportMultiple('100', '2026-02-20', { id: 7 } as any);

    expect(res.orderDeliveryList).toHaveLength(2);
    const dates = new Set(res.orderDeliveryList.map((l: any) => l.sendRequestAt));
    expect(dates.size).toBe(1); // 분리된 행들이 서로 다른 일자를 갖지 않는다
    expect([...dates][0]).toContain('2026-02-20');
  });
});
