export interface GiftiShowIssueIn {
  transactionId: string; // Clico_Issu_Paym_No
  partnerCompanyCode: string; // Issu_Req_Val
}

export interface GifitiShowCheckIn {
  transactionId?: string; // tr_id로 조회
  pinNo?: string; // pin_no로 조회 (둘 중 하나 필수)
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

// V2 API 응답
export interface GiftiShowCheckOut {
  resCode: string; // 응답 코드 (0000 = 성공)
  resMsg: string; // 응답 메시지
  couponInfo?: GiftiShowCouponInfo; // 쿠폰 정보 (couponInfoList[0])
}

export interface GiftiShowCouponInfo {
  pinNo: string; // 핀번호
  pinStatusCd: string; // 핀상태코드 (01:발행, 02:교환, 07:취소, 08:만료)
  pinStatusNm: string; // 핀상태명
  goodsNm?: string; // 상품명
  brandNm?: string; // 브랜드명
  branchNm?: string; // 지점명 (오프라인 교환 시)
  tradeBranchNm?: string; // 거래지점명 (오프라인 교환 시)
  useComNm?: string; // 사용처명 (온라인 교환 시)
  remainAmt?: string; // 잔액 (금액형)
  exchDtm?: string; // 교환일시 (YYYYMMDDHHmmss) - 교환 상태일 때
  apprvDtm?: string; // POS 승인일시 - 교환 상태일 때
  cancelDtm?: string; // 취소일시 - 취소 상태일 때
  validPrdEndDt?: string; // 유효기간 종료일
}

export interface IGiftiShow {
  issue(obj: GiftiShowIssueIn): Promise<GiftiShowIssueOut>;

  check(obj: GifitiShowCheckIn): Promise<GiftiShowCheckOut>;

  cancel(obj: GifitiShowCancelIn): Promise<void>;
}
