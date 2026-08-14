import {
  buildCreditExcessSnapshot,
  diffCreditExcessSnapshot,
  fingerprintDeliveryTarget,
} from './credit-excess-snapshot';

/**
 * [EP-P23] PII 최소화 스냅샷 + 변경 항목 비교.
 */
describe('credit excess snapshot', () => {
  const order = () =>
    ({
      id: 77,
      status: 'REVIEW_COMPLETE',
      type: 'GENERAL',
      orderProductMappings: [
        {
          id: 10,
          productId: 100,
          amount: 2,
          fee: 5,
          priceAdjustment: 'DISCOUNT',
          sendType: 'IMMEDIATE',
          product: { price: 10000 },
          orderDeliveries: [
            { id: 2, deliveryTarget: 'enc-01011112222', ssgEventId: null },
            { id: 1, deliveryTarget: 'enc-01033334444', ssgEventId: 55 },
          ],
        },
      ],
    }) as any;

  const build = (overrides: Record<string, unknown> = {}) =>
    buildCreditExcessSnapshot({
      order: order(),
      lifecycleMode: 'WALLET',
      billingUserId: 2,
      walletAccountId: 'w-1',
      settleMethod: 'CASH',
      cardSurchargeApplied: false,
      finalAmount: 20000,
      remainServiceAmount: 5000,
      excessAmount: 15000,
      payableSettlementAmount: 20000,
      usage: {},
      allocation: {
        pointUsedAmount: 0,
        depositUsedAmount: 5000,
        creditUsedAmount: 0,
        creditExcessAmount: 15000,
        cardSurchargeAmount: 0,
      },
      ...(overrides as any),
    });

  it('수신처 원문을 저장하지 않고 지문만 저장한다', () => {
    const snapshot = build();
    const raw = JSON.stringify(snapshot);

    expect(raw).not.toContain('enc-01011112222');
    expect(snapshot.deliveries[0].targetFingerprint).toBe(fingerprintDeliveryTarget('enc-01033334444'));
    expect(snapshot.deliveries[0].targetFingerprint).toHaveLength(32);
  });

  it('배송/상품은 id 오름차순으로 정규화해 순서 차이를 변경으로 오탐하지 않는다', () => {
    expect(build().deliveries.map((d) => d.id)).toEqual([1, 2]);
  });

  it('동일 입력은 변경 항목이 없다', () => {
    expect(diffCreditExcessSnapshot(build(), build())).toEqual([]);
  });

  it.each([
    [{ payableSettlementAmount: 21000 }, '결제 금액'],
    [{ excessAmount: 16000 }, '신용초과 금액'],
    [{ remainServiceAmount: 6000 }, '잔여 한도'],
    [{ walletAccountId: 'w-2' }, '정산 계정'],
    [{ settleMethod: 'CARD' }, '결제 수단'],
    [{ cardSurchargeApplied: true }, '카드 할증'],
    [{ finalAmount: 30000 }, '최종 정산 금액'],
    [{ lifecycleMode: 'LEGACY' }, '정산 처리 모드'],
    [{ usage: { pointUseAmount: 1000 } }, '포인트/예치금 사용 입력'],
  ])('%o 변경은 %s 항목으로 표시한다', (override, label) => {
    expect(diffCreditExcessSnapshot(build(), build(override))).toContain(label);
  });

  it('상품 가격/할인이 바뀌면 상품 구성 변경으로 표시한다', () => {
    const changed = build();
    changed.products[0].fee = 10;

    expect(diffCreditExcessSnapshot(build(), changed)).toContain('상품 구성/가격');
  });

  it('수신 대상과 신세계 이벤트 변경을 각각 구분한다', () => {
    const targetChanged = build();
    targetChanged.deliveries[0].targetFingerprint = 'x'.repeat(32);
    expect(diffCreditExcessSnapshot(build(), targetChanged)).toContain('수신 대상');

    const eventChanged = build();
    eventChanged.deliveries[0].ssgEventId = 999;
    expect(diffCreditExcessSnapshot(build(), eventChanged)).toEqual(['신세계 이벤트 연결']);
  });

  it('결제 배분이 달라지면 배분 변경으로 표시한다', () => {
    const changed = build();
    changed.allocation!.depositUsedAmount = 4000;

    expect(diffCreditExcessSnapshot(build(), changed)).toContain('결제 배분');
  });
});
