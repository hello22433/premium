import { buildReconciliation } from './auto.order.reconciliation';

describe('buildReconciliation', () => {
  it('정상: 합계가 expected와 일치, matched=true', () => {
    // 입력 10, 미매핑 2, 제외 1, 생성 7 → blocked = 10-2-1-7 = 0
    const r = buildReconciliation({ inputRowCount: 10, unmappedCount: 2, excludedCount: 1, builtDeliveryCount: 7 });
    expect(r.blockedDeliveryCount).toBe(0);
    expect(r.builtDeliveryCount + r.unmappedCount + r.excludedCount + r.blockedDeliveryCount).toBe(10);
    expect(r.matched).toBe(true);
  });

  it('차단 발생: blocked가 뺄셈으로 채워져 합계 유지', () => {
    // 입력 10, 미매핑 0, 제외 0, 생성 7 → blocked = 3 (금칙어 등)
    const r = buildReconciliation({ inputRowCount: 10, unmappedCount: 0, excludedCount: 0, builtDeliveryCount: 7 });
    expect(r.blockedDeliveryCount).toBe(3);
    expect(r.matched).toBe(true);
  });

  it('파일 전체 차단: built=0, blocked=전체', () => {
    const r = buildReconciliation({ inputRowCount: 10, unmappedCount: 2, excludedCount: 1, builtDeliveryCount: 0 });
    expect(r.blockedDeliveryCount).toBe(7);
    expect(r.matched).toBe(true);
  });

  it('built 과다(중복계상 버그) → blocked<0 → matched=false', () => {
    const r = buildReconciliation({ inputRowCount: 5, unmappedCount: 0, excludedCount: 0, builtDeliveryCount: 8 });
    expect(r.blockedDeliveryCount).toBe(-3);
    expect(r.matched).toBe(false);
  });

  it('입력 0건', () => {
    const r = buildReconciliation({ inputRowCount: 0, unmappedCount: 0, excludedCount: 0, builtDeliveryCount: 0 });
    expect(r.expectedDeliveryCount).toBe(0);
    expect(r.blockedDeliveryCount).toBe(0);
    expect(r.matched).toBe(true);
  });
});
