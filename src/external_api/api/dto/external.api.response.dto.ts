import { IProductType } from '../../../product/interface/product.type';

/**
 * 외부 API 응답 본문 타입.
 * 글로벌 `TransformResInterceptor`가 `{ result: <body> }`로 한 번 래핑하므로
 * 컨트롤러는 평면 객체(code/message/data)만 반환한다.
 */
export interface ExternalApiResponse<T = any> {
  code: string;
  message: string;
  data?: T;
}

export const ExternalApiResponse = {
  success<T>(data?: T): ExternalApiResponse<T> {
    const body: ExternalApiResponse<T> = { code: '0000', message: 'success' };
    if (data !== undefined) body.data = data;
    return body;
  },
};

export class OrderResponseData {
  trId: string;
  barCode?: string;
  validStartDate?: string;
  validEndDate?: string;
  /** 정가 (할인/할증 미반영, 카드할증 미반영) */
  price: number;
  /** 실제 차감/결제 금액 (할인/할증 + 카드할증 반영) */
  settleAmount: number;
}

export class SsgOrderResponseData extends OrderResponseData {
  personalCode?: string;
}

export enum ExternalCouponStatus {
  ISSUED = 'ISSUED',
  DISCARDED = 'DISCARDED',
}

/**
 * 발송 결과. 고객사는 "발송에 성공했는지" 만 알면 충분하므로 성공/실패 2상태로 축약한다.
 * - SUCCESS: 쿠폰이 실제로 발송됨(알림톡 또는 SMS 대체 전송 성공 포함)
 * - FAIL: 발송 실패(미발송)
 */
export enum ExternalDeliveryStatus {
  SUCCESS = 'SUCCESS',
  FAIL = 'FAIL',
}

export class OrderStatusResponseData extends OrderResponseData {
  couponStatus: ExternalCouponStatus;
  deliveryStatus: ExternalDeliveryStatus;
}

export class SsgOrderStatusResponseData extends OrderStatusResponseData {
  personalCode?: string;
}

/**
 * externalOrderId(호출자 reqTrId) 기준 주문 조회 응답 (reconcile 전용, 읽기 전용).
 * found=false → Nest 에 해당 주문 자체가 없음(미착지/미커밋). deliveryStatus 는 barCode + 발송 성공
 * 이력을 함께 반영해 완료 전이 전(크래시 윈도우)에도 실발송 여부를 정직하게 보고한다(#3).
 */
export class OrderLookupResponseData {
  found: boolean;
  trId?: string;
  /** 내부 진행상태 raw (DELIVERY_REQUEST/DELIVERY_COMPLETE/DELIVERY_CANCEL 등) — 호출자 reconcile 분기용. */
  orderStatus?: string;
  couponStatus?: ExternalCouponStatus;
  deliveryStatus?: ExternalDeliveryStatus;
  barCode?: string;
  personalCode?: string;
  validStartDate?: string;
  validEndDate?: string;
}

export class ProductResponseData {
  productCode: string;
  productName: string;
  brandName: string;
  price: number;
  salePrice: number;
  imageUrl: string;
  validDays: number;
  type: IProductType;
  memo: string | null;
  isCancelable: boolean;
}
