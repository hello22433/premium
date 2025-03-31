export interface ErpRequestIn {
  SaleOrderList: SaleOrder[];
}

export interface SaleOrder {
  BulkDatas: BulkData;
}

export interface BulkData {
  U_MEMO1: string; // 고객명
  CUST_DES: string; // 고객사
  WH_CD: string; // 창고 코드
  U_MEMO4: string; // 이벤트명
  TIME_DATE: string; // 날짜 (형식: YYYYMMDD)
  ADD_TXT_10_T: string; // 이벤트 상세
  U_TXT1: string; // 특이 사항
  PROD_CD: string; // 제품 코드
  REMARKS: string; // 브랜드명
  P_REMARKS1: string; // 공급처명
  PROD_DES: string; // 품목명
  QTY: string; // 수량 (숫자 데이터도 문자열로 처리)
  PRICE: string; // 단가 (숫자 데이터도 문자열로 처리)
  SUPPLY_AMT: string; // 공급 금액 (숫자 데이터도 문자열로 처리)
  P_REMARKS2: string; // 담당자
}
