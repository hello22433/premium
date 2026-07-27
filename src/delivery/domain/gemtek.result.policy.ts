/**
 * Gemtek 문자 결과 코드 정책 (§4).
 *
 * 실측 확정(2026-07-24 `MSG_RESULT_202607`): **최종 성공은 `(STAT='3', RESULT='0')` 조합뿐**이다.
 * STAT 은 성공/실패를 가르지 않고 **확정 여부**만 표시하며 판정은 RESULT 가 한다.
 * 미등록 조합·미확정은 성공으로 추정하지 않고 `UNKNOWN` 으로 남긴다.
 */
export enum GemtekResultOutcome {
  /** `(3,'0')` — 최종 성공 확정 */
  SUCCEEDED = 'SUCCEEDED',
  /** 확정 실패이며 자동 재발송 금지(520/505/203/503 등) */
  FAILED_FINAL = 'FAILED_FINAL',
  /** `RESULT='504'`(이통사 expired) — 재발송 가능 실패. 활성화는 §10 4단계 canary */
  RETRYABLE_504 = 'RETRYABLE_504',
  /** 미확정(`STAT≠'3'`·`RESULT IS NULL`) 또는 전달 여부 불명(519)·미분류 코드 */
  UNKNOWN = 'UNKNOWN',
}

/** 최종 성공 조합 (§4 실측 확정) */
export const GEMTEK_SUCCESS_STAT = '3';
export const GEMTEK_SUCCESS_RESULT = '0';

/** 확정 실패로 분류하는 결과 코드 — 자동 재발송 금지, 실패내역 노출 (§4) */
export const GEMTEK_TERMINAL_RESULTS = new Set(['520', '505', '503', '203']);

/** 전달 여부가 불명해 운영 확인으로 넘기는 코드 (§4: 519 = E_TELCO_ETC) */
export const GEMTEK_UNKNOWN_RESULTS = new Set(['519']);

/** 재발송 가능 실패 (§4: 504 = expired) */
export const GEMTEK_RETRYABLE_RESULT = '504';

export interface GemtekResultRow {
  stat: string | null;
  result: string | null;
}

/**
 * `(STAT, RESULT)` 조합을 상태 판정으로 변환한다.
 *
 * - `STAT ≠ '3'` 또는 `RESULT IS NULL` → 아직 확정 전이므로 `UNKNOWN`(계속 추적)
 * - `(3,'0')` → `SUCCEEDED`
 * - `(3,'504')` → `RETRYABLE_504`
 * - `(3, 520|505|503|203)` → `FAILED_FINAL`
 * - `(3, 519)` 및 **미등록 조합** → `UNKNOWN`(자동 재발송·자동 종결 금지, 운영 확인)
 */
export function classifyGemtekResult(row: GemtekResultRow): GemtekResultOutcome {
  const { stat, result } = row;

  if (stat !== GEMTEK_SUCCESS_STAT || result === null || result === undefined || result === '') {
    return GemtekResultOutcome.UNKNOWN;
  }

  if (result === GEMTEK_SUCCESS_RESULT) {
    return GemtekResultOutcome.SUCCEEDED;
  }

  if (result === GEMTEK_RETRYABLE_RESULT) {
    return GemtekResultOutcome.RETRYABLE_504;
  }

  if (GEMTEK_TERMINAL_RESULTS.has(result)) {
    return GemtekResultOutcome.FAILED_FINAL;
  }

  if (GEMTEK_UNKNOWN_RESULTS.has(result)) {
    return GemtekResultOutcome.UNKNOWN;
  }

  // 미분류 코드는 실패로도 성공으로도 단정하지 않는다(§4 마지막 행).
  return GemtekResultOutcome.UNKNOWN;
}
