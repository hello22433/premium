import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

// 파트너사 타입
export type PartnerCompanyType =
  | 'GALAXIA'
  | 'GS_M_BIZ'
  | 'GIFTIEL'
  | 'GIFT_SHOW'
  | 'CULTURELAND'
  | 'SSG'
  | 'DAOU';

// API 호출 결과 (DB 저장 전)
export interface ApiCallResult {
  id: number;
  skipped: boolean;
  couponStatus?: OrderDeliveryCouponStatus;
  tradeAt?: Date | null;
  tradePlace?: string | null;
  galaxiaBalance?: number | null;
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