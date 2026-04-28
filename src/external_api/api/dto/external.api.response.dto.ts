export class ExternalApiResponse<T = any> {
  code: string;
  message: string;
  data?: T;

  static success<T>(data?: T): ExternalApiResponse<T> {
    const res = new ExternalApiResponse<T>();
    res.code = '0000';
    res.message = 'success';
    res.data = data;
    return res;
  }

  static error(code: string, message: string, detail?: string): ExternalApiResponse {
    const res = new ExternalApiResponse();
    res.code = code;
    res.message = message;
    if (detail) {
      (res as any).detail = detail;
    }
    return res;
  }
}

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

export class OrderStatusResponseData {
  trId: string;
  couponStatus: string;
  deliveryStatus: string;
  barCode?: string;
  validStartDate?: string;
  validEndDate?: string;
  /** 정가 (할인/할증 미반영, 카드할증 미반영) */
  price: number;
  /** 실제 차감/결제 금액 (할인/할증 + 카드할증 반영) */
  settleAmount: number;
}

export class SsgOrderStatusResponseData extends OrderStatusResponseData {
  personalCode?: string;
}

export class ProductResponseData {
  productCode: string;
  productName: string;
  brandName: string;
  price: number;
  salePrice: number;
  imageUrl: string;
  validDays: number;
}
