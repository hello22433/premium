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
