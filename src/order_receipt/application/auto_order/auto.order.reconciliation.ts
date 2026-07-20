import { AutoOrderReconciliation } from './auto.order.types';

export interface ReconciliationInput {
  inputRowCount: number; // 파싱된 입력 행 수(빈 행 스킵 후) = 의도된 발송건 총합
  unmappedCount: number; // 상품코드 미매핑
  excludedCount: number; // _유효=False
  mappedCount: number; // 상품 매핑된 행(general+ssg) — built의 상한
  builtDeliveryCount: number; // 실제 주문에 들어간 발송건 수
}

/**
 * 검산표 계산 (순수 함수) — 양방향 검산.
 * 4버킷(excluded/unmapped/mapped)은 입력행의 서로소 분할이어야 한다.
 * blocked는 mapped−built로 독립 산출하고(뺄셈 은폐 방지), 아래 셋을 모두 만족해야 matched=true:
 *   (1) partitionOk : input === unmapped + excluded + mapped   (행이 어느 버킷에도 안 세이고 증발하면 깨짐)
 *   (2) builtWithinMapped : built ≤ mapped                      (built 과다 = 중복계상 버그)
 *   (3) blocked ≥ 0
 * 과거엔 blocked를 expected 뺄셈으로만 구해 "실종된 수신자"를 양수 blocked로 흡수해 초록으로 통과했다.
 */
export function buildReconciliation(input: ReconciliationInput): AutoOrderReconciliation {
  const expected = input.inputRowCount;
  const blockedDeliveryCount = input.mappedCount - input.builtDeliveryCount;

  const partitionOk = expected === input.unmappedCount + input.excludedCount + input.mappedCount;
  const builtWithinMapped = input.builtDeliveryCount <= input.mappedCount;

  return {
    inputRowCount: input.inputRowCount,
    expectedDeliveryCount: expected,
    builtDeliveryCount: input.builtDeliveryCount,
    unmappedCount: input.unmappedCount,
    excludedCount: input.excludedCount,
    blockedDeliveryCount,
    matched: partitionOk && builtWithinMapped && blockedDeliveryCount >= 0,
  };
}
