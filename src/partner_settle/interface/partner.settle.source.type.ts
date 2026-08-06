/** 정산 원장 이벤트 종류 (정본 §5.1 sourceType). */
export type IPartnerSettleSourceType = 'ISSUANCE' | 'EXCHANGE' | 'USAGE' | 'ADJUSTMENT';

/** 원장 격리 상태 (정본 §5.1 status). */
export type IPartnerSettleLedgerStatus = 'NORMAL' | 'NEEDS_REVIEW' | 'ON_HOLD';

/** 격리 원인 (정본 §5.1 reviewCode). */
export type IPartnerSettleReviewCode =
  | 'COVERAGE_GAP'
  | 'TIME_UNRECOVERABLE'
  | 'PRICE_UNRECOVERABLE'
  | 'POLICY_CONFLICT'
  | 'UNKNOWN_PROVIDER_EVENT';

/** 격리 종결 상태. 재계산 성공은 NORMAL 전환이라 여기 없다. */
export type IPartnerSettleReviewResolution = 'PENDING' | 'DISCARDED';

/** 매입율 판정 근거 (정본 §5.1 pricingResolution). */
export type IPartnerSettlePricingResolution = 'HISTORY_MATCH' | 'NO_MATCH' | 'DIRECT_AMOUNT';

/** 거래 당시 VAT 정책 (정본 §6.6). */
export type IPartnerSettleVatCalculationMode = 'SEPARATE_ROUND' | 'INCLUDED_REMAINDER' | 'NONE';

/** 전이 event 의 멱등 ID 출처. */
export type IPartnerSettleSourceEventIdOrigin = 'PROVIDER' | 'MANUAL';
