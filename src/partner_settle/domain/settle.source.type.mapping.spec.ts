import { isSettlementEvent, resolveSourceType } from './settle.source.type.mapping';

describe('resolveSourceType', () => {
  it('상품 settleMethod 가 sourceType 을 결정한다', () => {
    expect(resolveSourceType('PER_ISSUANCE')).toBe('ISSUANCE');
    expect(resolveSourceType('PER_EXCHANGE')).toBe('EXCHANGE');
    expect(resolveSourceType('PER_PRODUCT')).toBe('USAGE');
  });
  it('PREPAID_INVENTORY 는 공급사 정산 제외(EXCLUDED)다', () => {
    expect(resolveSourceType('PREPAID_INVENTORY')).toBe('EXCLUDED');
  });
});

describe('isSettlementEvent', () => {
  it('발행 정산 상품의 사용·교환 관측은 원장 사건이 아니다', () => {
    // 한국문화진흥은 전 상품 PER_ISSUANCE 라 발행 시 이미 정산됐다. 사용조회로 또 만들면 이중 정산이다.
    expect(isSettlementEvent('PER_ISSUANCE', 'ISSUANCE')).toBe(true);
    expect(isSettlementEvent('PER_ISSUANCE', 'EXCHANGE')).toBe(false);
    expect(isSettlementEvent('PER_ISSUANCE', 'USAGE')).toBe(false);
  });

  it('교환 정산 상품은 교환 관측만 원장 사건이다', () => {
    expect(isSettlementEvent('PER_EXCHANGE', 'EXCHANGE')).toBe(true);
    expect(isSettlementEvent('PER_EXCHANGE', 'ISSUANCE')).toBe(false);
  });

  it('사용 정산 상품은 사용 관측만 원장 사건이다', () => {
    expect(isSettlementEvent('PER_PRODUCT', 'USAGE')).toBe(true);
    expect(isSettlementEvent('PER_PRODUCT', 'EXCHANGE')).toBe(false);
  });

  it('settleMethod 를 모르면 원장을 만들지 않는다', () => {
    // 추정으로 만들면 §14 O4(settleMethod 오설정)와 겹쳐 잘못된 시점에 정산이 잡힌다.
    expect(isSettlementEvent(null, 'USAGE')).toBe(false);
    expect(isSettlementEvent(undefined, 'ISSUANCE')).toBe(false);
  });
  it('PREPAID_INVENTORY 는 어떤 사건에서도 정산 대상이 아니다 (rev5 §10)', () => {
    expect(isSettlementEvent('PREPAID_INVENTORY', 'ISSUANCE')).toBe(false);
    expect(isSettlementEvent('PREPAID_INVENTORY', 'EXCHANGE')).toBe(false);
    expect(isSettlementEvent('PREPAID_INVENTORY', 'USAGE')).toBe(false);
  });
});
