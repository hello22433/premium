import { buildReconciliation } from './auto.order.reconciliation';

/** 기본 입력(정상: built === expectedBuilt) 위에 오버라이드 */
function input(o: Partial<Parameters<typeof buildReconciliation>[0]> = {}) {
  const base = { inputRowCount: 0, unmappedCount: 0, excludedCount: 0, mappedCount: 0, builtDeliveryCount: 0, expectedBuiltCount: 0 };
  return buildReconciliation({ ...base, ...o });
}

describe('buildReconciliation', () => {
  it('정상: 합계 일치 + built===expectedBuilt → matched=true', () => {
    // 입력 10, 미매핑 2, 제외 1, 매핑 7, 생성 7(=기대) → blocked = 0
    const r = input({ inputRowCount: 10, unmappedCount: 2, excludedCount: 1, mappedCount: 7, builtDeliveryCount: 7, expectedBuiltCount: 7 });
    expect(r.blockedDeliveryCount).toBe(0);
    expect(r.builtDeliveryCount + r.unmappedCount + r.excludedCount + r.blockedDeliveryCount).toBe(10);
    expect(r.expectedBuiltCount).toBe(7); // 출력에 echo(경계 매퍼가 DTO expectedDeliveryCount로 투영)
    expect(r.matched).toBe(true);
  });

  it('차단 발생: 매핑 10, 기대생성 7(3건 차단), 실제 7 → matched=true, blocked=3', () => {
    const r = input({ inputRowCount: 10, mappedCount: 10, builtDeliveryCount: 7, expectedBuiltCount: 7 });
    expect(r.blockedDeliveryCount).toBe(3);
    expect(r.matched).toBe(true);
  });

  it('파일 전체 차단: 기대생성 0, 실제 0 → matched=true, blocked=매핑 전체', () => {
    const r = input({ inputRowCount: 10, unmappedCount: 2, excludedCount: 1, mappedCount: 7, builtDeliveryCount: 0, expectedBuiltCount: 0 });
    expect(r.blockedDeliveryCount).toBe(7);
    expect(r.expectedBuiltCount).toBe(0); // DTO expectedDeliveryCount로 투영되면 "기대 0 / 구성 0 / ✓" 정합
    expect(r.matched).toBe(true);
  });

  // ── 핵심: 사유 없이 행이 사라짐(built < expectedBuilt) → matched=false (뺄셈검산이 놓치던 케이스)
  it('무사유 드롭: 매핑 5·차단 0이라 기대 5인데 실제 4 → matched=false', () => {
    const r = input({ inputRowCount: 5, mappedCount: 5, builtDeliveryCount: 4, expectedBuiltCount: 5 });
    expect(r.matched).toBe(false); // 1명이 사유 없이 실종
  });

  it('중복계상: 기대 5인데 실제 8 → matched=false', () => {
    const r = input({ inputRowCount: 5, mappedCount: 5, builtDeliveryCount: 8, expectedBuiltCount: 5 });
    expect(r.matched).toBe(false);
  });

  it('파티션 깨짐(행 증발): input≠unmapped+excluded+mapped → matched=false', () => {
    // 입력 10인데 2+1+5=8 (2건 증발)
    const r = input({ inputRowCount: 10, unmappedCount: 2, excludedCount: 1, mappedCount: 5, builtDeliveryCount: 5, expectedBuiltCount: 5 });
    expect(r.matched).toBe(false);
  });

  it('입력 0건 → matched=true', () => {
    const r = input({});
    expect(r.expectedDeliveryCount).toBe(0);
    expect(r.blockedDeliveryCount).toBe(0);
    expect(r.matched).toBe(true);
  });
});
