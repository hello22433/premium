import { AutoOrderReconciliation } from './auto.order.types';

export interface ReconciliationInput {
  inputRowCount: number; // 파싱된 입력 행 수(빈 행 스킵 후) = 의도된 발송건 총합
  unmappedCount: number; // 상품코드 미매핑
  excludedCount: number; // _유효=False
  mappedCount: number; // 상품 매핑된 행(general+ssg) — built의 상한
  builtDeliveryCount: number; // 실제 주문에 들어간 발송건 수
  expectedBuiltCount: number; // 차단 이유들로 독립 산출한 "생성돼야 할" 건수(오케스트레이터가 계산해 주입)
}

/**
 * 검산표 계산 (순수 함수) — 양방향 검산.
 * ★ 핵심: blocked를 뺄셈으로 만들면 "사유 없이 사라진 행"이 양수 blocked로 흡수돼 늘 초록이 된다.
 *   그래서 오케스트레이터가 실제 차단 이유(ROW차단/SSG창밖/파일차단)로 독립 산출한 expectedBuilt와
 *   실제 built를 직접 대조한다. built ≠ expectedBuilt면 = 조립 단계가 사유 없이 행을 흘렸거나 이중계상한 것.
 * matched는 다음을 모두 만족해야 true:
 *   (1) partitionOk : input === unmapped + excluded + mapped   (매핑 서로소 분할 회귀 가드)
 *   (2) builtMatchesExpected : built === expectedBuilt          (무사유 드롭/중복계상 실검출)
 */
export function buildReconciliation(input: ReconciliationInput): AutoOrderReconciliation {
  const expected = input.inputRowCount;
  const blockedDeliveryCount = input.mappedCount - input.builtDeliveryCount;

  const partitionOk = expected === input.unmappedCount + input.excludedCount + input.mappedCount;
  const builtMatchesExpected = input.builtDeliveryCount === input.expectedBuiltCount;

  return {
    inputRowCount: input.inputRowCount,
    expectedDeliveryCount: expected,
    builtDeliveryCount: input.builtDeliveryCount,
    unmappedCount: input.unmappedCount,
    excludedCount: input.excludedCount,
    blockedDeliveryCount,
    matched: partitionOk && builtMatchesExpected,
  };
}
