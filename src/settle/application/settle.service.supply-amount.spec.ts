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
 * PR #533(D3-49) 리뷰 코멘트② 대응 — "평균단가를 반올림하는데 이거 맞아요?"
 *
 * SSG 차등정산(발송건별 요율 상이)에서는 표시 단가(price)가 라인총액/수량 평균(반올림)이라,
 * 프론트가 price*amount 로 합계를 재구성하면 실제 정산액(lineTotal)과 1원 이상 어긋날 수 있었다.
 * (거래명세서(order.service.ts getOrderCompleteReport)는 이미 unitPrice/price 두 필드를 분리해
 *  정확한 합계를 별도로 제공 — 그 관례를 getUserDetail/getUserDetailMultiple 에도 동일 적용.)
 *
 * 재구성 없이 그대로 쓸 수 있는 정확한 합계를 supplyAmount 필드로 제공해 이 어긋남을 제거한다.
 */
describe('SettleService.getUserDetail / getUserDetailMultiple — supplyAmount (D3-49 코멘트②)', () => {
  // 3335원 상품, 발송건1=10%할인(3001) 발송건2=11%할인(2968) → lineTotal=5969(홀수, 2로 안 나누어떨어짐)
  // adjustedPrice = round(5969/2) = 2985 → price*amount = 5970 ≠ lineTotal(5969)
  const makeMapping = () => ({
    id: 11,
    product: { id: 501, code: 'P501', price: 3335, brand: { nameKorean: '테스트브랜드' } },
    productId: 501,
    amount: 2,
    fee: null,
    priceAdjustment: null,
    orderDeliveries: [
      { settleFee: 10, settlePriceAdjustment: 'DISCOUNT', actualSendAt: null },
      { settleFee: 11, settlePriceAdjustment: 'DISCOUNT', actualSendAt: null },
    ],
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

  it('getUserDetail: supplyAmount=정확한 lineTotal(5969). price*amount(5970)와 어긋남을 확인', async () => {
    const order = makeOrder(999, [makeMapping()]);
    const svc = makeService({
      orderRepository: { createQueryBuilder: jest.fn().mockReturnValue(makeQb(order)) },
    });

    const res = await svc.getUserDetail({ orderId: 999 });
    const product = res.productList[0].product;

    expect(product.price).toBe(2985); // 평균단가(표시용, 근사)
    expect(product.supplyAmount).toBe(5969); // 정확한 라인 합계 — 실제 정산액과 일치
    expect(product.price * product.amount).not.toBe(product.supplyAmount); // 재구성하면 어긋남을 방증(5970≠5969)
  });

  it('getUserDetailMultipleByOrderIds: 동일 키(상품+평균단가)로 병합될 때 supplyAmount도 정확히 누적', async () => {
    const order1 = makeOrder(1001, [makeMapping()]);
    const order2 = makeOrder(1002, [makeMapping()]);
    const svc = makeService({
      orderRepository: { createQueryBuilder: jest.fn().mockReturnValue(makeQb([order1, order2], true)) },
    });

    const res = await svc.getUserDetailMultipleByBody({ orderIds: [1001, 1002] } as any);
    const product = res.productList[0];

    expect(res.productList).toHaveLength(1); // 상품ID+평균단가(2985) 동일 → 한 줄로 병합
    expect(product.amount).toBe(4); // 2 + 2
    expect(product.supplyAmount).toBe(11938); // 5969 + 5969 (price*amount 재구성이면 2985*4=11940, 2원 오차)
    expect(product.price * product.amount).not.toBe(product.supplyAmount);
  });
});
