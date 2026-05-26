import { Injectable } from '@nestjs/common';

/**
 * Shadow mode 비교 로그 의 mismatch 분류.
 *
 * Cutover Bundle (plan v2.1 F-007) 의 단일 owner. real_drift 만 PagerDuty critical 로 라우팅하고
 * 나머지 (rounding_only / point_grant_diff / mirror_lag) 는 warning + Slack 으로 noise 분리.
 *
 * 분류 우선순위 (위에서 아래로):
 *   1. exact_match (delta 0): return null (호출자가 mismatch counter 증가 안 함)
 *   2. mirror_lag: wallet 결과는 모두 0 + legacy non-zero → wallet 진입 안 한 case
 *   3. rounding_only: 모든 컬럼 절대차 ≤ 10 (카드할증 10원 단위 절사)
 *   4. point_grant_diff: point_used_amount 만 차이 + 그 외 컬럼 동일
 *   5. real_drift: 위 어디에도 안 맞는 차이
 *   6. unknown: 입력 모양이 invalid (computed delta 계산 실패 등)
 */
export enum ShadowMismatchClass {
  ROUNDING_ONLY = 'rounding_only',
  POINT_GRANT_DIFF = 'point_grant_diff',
  MIRROR_LAG = 'mirror_lag',
  REAL_DRIFT = 'real_drift',
  UNKNOWN = 'unknown',
}

export interface ShadowComparable {
  depositUsedAmount: number;
  creditUsedAmount: number;
  creditExcessAmount: number;
  pointUsedAmount: number;
  cardSurchargeAmount: number;
  payableSettlementAmount: number;
}

const ROUNDING_TOLERANCE = 10;

@Injectable()
export class ShadowMismatchClassifierService {
  /**
   * @returns null = exact match. ShadowMismatchClass = mismatch class.
   */
  classify(walletPreview: ShadowComparable, legacyResult: ShadowComparable): ShadowMismatchClass | null {
    const fields: Array<keyof ShadowComparable> = [
      'depositUsedAmount',
      'creditUsedAmount',
      'creditExcessAmount',
      'pointUsedAmount',
      'cardSurchargeAmount',
      'payableSettlementAmount',
    ];

    let allEqual = true;
    let nonPointEqual = true;
    let allWithinRounding = true;
    let walletAllZero = true;
    let legacyAllZero = true;

    for (const f of fields) {
      const w = walletPreview[f];
      const l = legacyResult[f];
      if (typeof w !== 'number' || typeof l !== 'number' || !Number.isFinite(w) || !Number.isFinite(l)) {
        return ShadowMismatchClass.UNKNOWN;
      }
      const delta = Math.abs(w - l);
      if (delta !== 0) {
        allEqual = false;
        if (f !== 'pointUsedAmount') {
          nonPointEqual = false;
        }
        if (delta > ROUNDING_TOLERANCE) {
          allWithinRounding = false;
        }
      }
      if (w !== 0) walletAllZero = false;
      if (l !== 0) legacyAllZero = false;
    }

    if (allEqual) {
      return null;
    }
    if (walletAllZero && !legacyAllZero) {
      return ShadowMismatchClass.MIRROR_LAG;
    }
    if (allWithinRounding) {
      return ShadowMismatchClass.ROUNDING_ONLY;
    }
    if (nonPointEqual) {
      return ShadowMismatchClass.POINT_GRANT_DIFF;
    }
    return ShadowMismatchClass.REAL_DRIFT;
  }
}
