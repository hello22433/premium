export interface GiftiShowIssueIn {
  transactionId: string; // Clico_Issu_Paym_No
  partnerCompanyCode: string; // Issu_Req_Val
}

export interface GifitiShowCheckIn {
  transactionId: string;
}

export interface GifitiShowCancelIn {
  transactionId: string; // Clico_Issu_Paym_No
}

export interface GiftiShowIssueOut {
  response: {
    result: { code: string[]; reason: string[] }[];
    value: { pin_no: string[]; tr_id: string[]; ctr_id: string[] }[];
  };
}

export interface GiftiShowCheckOut {
  trID: string; // 사용자 요청 거래번호
  StatusCode: string; // 0 = 취소가능, 그 외 = 취소불가
  StatusText: string; // 실패 사유(등록·교환·취소·반품·기간만료·관리폐기)
  remainAmt?: string; // 금액형 상품권 잔액(교환권이면 필드 없음)
}

export interface IGiftiShow {
  issue(obj: GiftiShowIssueIn): Promise<GiftiShowIssueOut>;

  check(obj: GifitiShowCheckIn): Promise<GiftiShowCheckOut>;

  cancel(obj: GifitiShowCancelIn): Promise<void>;
}
