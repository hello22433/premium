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
  orderId: number;
  barCode?: string;
  couponNum?: string;
  validStartDate?: string;
  validEndDate?: string;
  price: number;
}

export class OrderStatusResponseData {
  trId: string;
  couponStatus: string;
  deliveryStatus: string;
  barCode?: string;
  couponNum?: string;
  validStartDate?: string;
  validEndDate?: string;
  price: number;
}

export class ProductResponseData {
  productId: number;
  productCode: string;
  productName: string;
  brandName: string;
  price: number;
  salePrice: number;
  imageUrl: string;
  validDays: number;
}
