import { buildReconciliation } from './auto.order.reconciliation';

describe('buildReconciliation', () => {
  it('정상: 합계가 expected와 일치, matched=true', () => {
    // 입력 10, 미매핑 2, 제외 1, 매핑 7, 생성 7 → blocked = 7-7 = 0
    const r = buildReconciliation({ inputRowCount: 10, unmappedCount: 2, excludedCount: 1, mappedCount: 7, builtDeliveryCount: 7 });
    expect(r.blockedDeliveryCount).toBe(0);
    expect(r.builtDeliveryCount + r.unmappedCount + r.excludedCount + r.blockedDeliveryCount).toBe(10);
    expect(r.matched).toBe(true);
  });

  it('차단 발생: blocked가 mapped-built로 채워져 합계 유지', () => {
    // 입력 10, 미매핑 0, 제외 0, 매핑 10, 생성 7 → blocked = 3 (금칙어 등)
    const r = buildReconciliation({ inputRowCount: 10, unmappedCount: 0, excludedCount: 0, mappedCount: 10, builtDeliveryCount: 7 });
    expect(r.blockedDeliveryCount).toBe(3);
    expect(r.matched).toBe(true);
  });

  it('파일 전체 차단: built=0, blocked=매핑 전체', () => {
    const r = buildReconciliation({ inputRowCount: 10, unmappedCount: 2, excludedCount: 1, mappedCount: 7, builtDeliveryCount: 0 });
    expect(r.blockedDeliveryCount).toBe(7);
    expect(r.matched).toBe(true);
  });

  it('built 과다(중복계상 버그) → built>mapped → matched=false', () => {
    const r = buildReconciliation({ inputRowCount: 5, unmappedCount: 0, excludedCount: 0, mappedCount: 5, builtDeliveryCount: 8 });
    expect(r.blockedDeliveryCount).toBe(-3);
    expect(r.matched).toBe(false);
  });

  it('입력 0건', () => {
    const r = buildReconciliation({ inputRowCount: 0, unmappedCount: 0, excludedCount: 0, mappedCount: 0, builtDeliveryCount: 0 });
    expect(r.expectedDeliveryCount).toBe(0);
    expect(r.blockedDeliveryCount).toBe(0);
    expect(r.matched).toBe(true);
  });

  // ── 양방향 검산: 뺄셈만으로 은폐되던 "실종 수신자"를 잡는다
  it('파티션 깨짐(행이 어느 버킷에도 없이 증발): input≠unmapped+excluded+mapped → matched=false', () => {
    // 입력 10인데 unmapped2+excluded1+mapped5 = 8 (2건이 증발). 과거 뺄셈검산이면 blocked=양수로 초록.
    const r = buildReconciliation({ inputRowCount: 10, unmappedCount: 2, excludedCount: 1, mappedCount: 5, builtDeliveryCount: 5 });
    expect(r.matched).toBe(false);
  });

  it('파티션 정상 + built가 mapped와 같음 → matched=true (blocked=0)', () => {
    const r = buildReconciliation({ inputRowCount: 6, unmappedCount: 1, excludedCount: 2, mappedCount: 3, builtDeliveryCount: 3 });
    expect(r.blockedDeliveryCount).toBe(0);
    expect(r.matched).toBe(true);
  });
});
