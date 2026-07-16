import { AutoOrderReconciliation } from './auto.order.types';

export interface ReconciliationInput {
  inputRowCount: number; // 파싱된 입력 행 수(빈 행 스킵 후) = 의도된 발송건 총합
  unmappedCount: number; // 상품코드 미매핑
  excludedCount: number; // _유효=False
  builtDeliveryCount: number; // 실제 주문에 들어간 발송건 수
}

/**
 * 검산표 계산 (순수 함수).
 * 각 입력 행 = 발송 1건. 4버킷이 서로소 분할이므로 blocked를 뺄셈으로 구하면
 * 합계는 항상 expected와 일치한다(중복계상 불가). built가 과다하면 blocked<0 → matched=false(코드 버그 신호).
 */
export function buildReconciliation(input: ReconciliationInput): AutoOrderReconciliation {
  const expected = input.inputRowCount;
  const blockedDeliveryCount = expected - input.unmappedCount - input.excludedCount - input.builtDeliveryCount;

  return {
    inputRowCount: input.inputRowCount,
    expectedDeliveryCount: expected,
    builtDeliveryCount: input.builtDeliveryCount,
    unmappedCount: input.unmappedCount,
    excludedCount: input.excludedCount,
    blockedDeliveryCount,
    matched: blockedDeliveryCount >= 0, // 음수 = built 과다 = 중복계상 버그
  };
}
