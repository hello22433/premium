export interface ErpProductListRequest {
  PROD_CD?: string;
  COMMA_FLAG?: 'Y' | 'N';
  PROD_TYPE?: string;
  FROM_PROD_CD?: string;
  TO_PROD_CD?: string;
}

export interface ErpProductDetailRequest {
  PROD_CD: string;
  PROD_TYPE?: string;
}
