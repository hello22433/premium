import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

// 파트너사 타입
export type PartnerCompanyType = 'GALAXIA' | 'GS_M_BIZ' | 'GIFTIEL' | 'GIFT_SHOW' | 'CULTURELAND' | 'SSG' | 'DAOU';

// API 호출 결과 (DB 저장 전)
export interface ApiCallResult {
  id: number;
  skipped: boolean;
  couponStatus?: OrderDeliveryCouponStatus;
  tradeAt?: Date | null;
  tradePlace?: string | null;
  galaxiaBalance?: number | null;
  discardedAt?: Date | null;
  /**
   * 정산 원장 producer 입력 (B14 · PR1B 명세 §4.1). **flag off 경로는 이 필드를 채우지 않는다**
   * — 미설정이면 updateOrderDelivery payload 가 1비트도 바뀌지 않는다(회귀 요건 §4.6).
   * 채워지는 경우에만 applyOrderDeliveryUpdate 래퍼가 상태 write 와 같은 트랜잭션에서 원장을 만든다.
   */
  settlementEvidence?: ApiCallSettlementEvidence;
}

/**
 * provider 원천 → 원장 producer 로 넘길 증적/식별 스냅샷 (정본 §14 source contract · 명세 §4.1).
 *
 * `callExternalApiWithTimeout` 이 provider 분기에서 원천 응답을 파싱하는 그 자리에서 채운다.
 * 여기서 채우지 않으면 나중 applyOrderDeliveryUpdate 래퍼는 provider raw 를 복원할 수 없다.
 */
export interface ApiCallSettlementEvidence {
  /** 감지한 사건 종류 — 정산성 판정 입력(sourceType 아님). settleMethod 와 일치할 때만 원장. */
  observedKind: 'ISSUANCE' | 'EXCHANGE' | 'USAGE';
  /** 관측이 취소/환불 전이인가 — true 면 recordCancellation(음수 역분개) 경로. */
  isCancellation?: boolean;
  /** 귀속 시각(KST 벽시계, 원천 정밀도 보존). NULL = 시각 복원 불가 → TIME_UNRECOVERABLE 격리. */
  occurredAt?: Date | null;
  /** 정가/사용액. NULL = 금액 복원 불가 → PRICE_UNRECOVERABLE 격리. */
  baseAmount?: bigint | null;
  discountAmount?: bigint;
  /** USAGE(갤럭시아) 원장의 galaxia_barcode_log FK. */
  galaxiaBarcodeLogId?: number | null;
  providerEvidenceRef?: string | null;
  providerEvidenceHash?: string | null;
  /** GIFT_SHOW 식별 원천. */
  transactionId?: string | null;
  pinStatusCd?: string | null;
  /** DAOU 관측 상태(스냅샷 전용, evidence = INBOX:{id}). */
  cpnStatus?: string | null;
  /** provider 정의 외 코드 — 금액 없이 UNKNOWN_PROVIDER_EVENT 격리. */
  unknownProviderEvent?: boolean;
}

// 배치 통계
export interface BatchStatistics {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  retried: number;
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
}

// 파트너사별 그룹
export interface PartnerCompanyGroup {
  type: PartnerCompanyType;
  items: OrderDeliveryEntity[];
  concurrencyLimit: number;
}

// 상태 검증 결과 (개별)
export interface VerifyItem {
  id: number;
  barCode: string | null;
  localStatus: string;
  partnerStatus: string | null;
  match: boolean;
  error?: string;
}

// 상태 검증 결과 (전체)
export interface VerifyResult {
  total: number;
  matched: number;
  mismatched: number;
  errors: number;
  mismatches: VerifyItem[];
}
