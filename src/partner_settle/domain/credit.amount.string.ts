/**
 * 여신 API 금액 canonical 문자열 계약 (정본 §5 금액 계약 · 26차 → 28차 확정).
 *
 * JSON number 는 파싱 전 2^53 초과 정밀도를 잃으므로 요청·응답 금액을 모두 정수 문자열로 다룬다.
 * - 요청 config 금액(insurance/prepaid/etc)은 **음수 불허** canonical 문자열만 받는다.
 * - 응답 금액은 `bigint` 를 canonical decimal string 으로 직렬화한다(선행 0·`+` 없음, 음수는 `-` 접두).
 *
 * canonical(28차): 음수 불허 = `^(0|[1-9]\d*)$`. 선행 0(`"000100"`)·`+`(`"+100"`)·`-0`·공백·빈 문자열은 거부.
 */

/** 음수 불허 canonical 정수 문자열 (여신 config 금액). */
const NON_NEGATIVE_CANONICAL = /^(0|[1-9]\d*)$/;

export class CreditAmountFormatError extends Error {}

/**
 * 여신 config 금액 문자열 → `bigint`.
 *
 * 음수·선행 0·부호·공백·빈 값·비정수 문자열을 전부 거부한다(호출부는 400 으로 변환).
 * `"100"` 과 `"0100"` 이 서로 다른 값으로 갈리지 않도록 canonical 형식만 통과시킨다.
 */
export function parseNonNegativeAmount(raw: unknown, field = 'amount'): bigint {
  if (typeof raw !== 'string') {
    throw new CreditAmountFormatError(`${field}: 금액은 정수 문자열이어야 한다 (받은 타입 ${typeof raw})`);
  }
  if (!NON_NEGATIVE_CANONICAL.test(raw)) {
    throw new CreditAmountFormatError(`${field}: canonical 음수불허 정수 문자열이 아니다 (${JSON.stringify(raw)})`);
  }
  return BigInt(raw);
}

/** `bigint` → canonical decimal string. 응답 직렬화 단일 경로. */
export function serializeAmount(value: bigint): string {
  return value.toString(10);
}
