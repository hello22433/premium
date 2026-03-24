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

export interface GiftiShowGoodsItem {
  goodsCd: string; // 상품 아이디
  goodsNm: string; // 상품명
  brandCd: string; // 브랜드코드
  brandNm: string; // 브랜드명
  sellPriceAmt: string; // 실판매 단가
  cnsmPriceAmt: string; // 정상판매 단가
  sellEndDt: string; // 판매 종료일자
  goodsTypeCd: string; // 상품유형코드
  goodsTypeNm: string; // 상품유형명
  goodsTypeDtlCd: string; // 상세상품유형코드
  goodsTypeDtlNm: string; // 상세상품유형명
  validPrdTypeCd: string; // 유효기간 유형 (01:일수, 02:일자)
  validPrdDay: string; // 유효기간(일자)
  validPrdDate: string; // 유효기간(일수)
  splcomCd?: string; // 상품공급사 아이디
  splcomNm?: string; // 상품공급사 명
  useComCode?: string; // 교환처 코드
  useComName?: string; // 교환처 명
  goodsImg250?: string; // 250x250 이미지
  goodsImg250Path?: string; // 250x250 이미지 경로
  goodsImg500?: string; // 500x500 이미지
  goodsImg500Path?: string; // 500x500 이미지 경로
  goodsImgDesc?: string; // 상품 설명 이미지
  goodsImgDescPath?: string; // 상품 설명 이미지 경로
  goodsImgSa?: string; // 간편인증 이미지
  goodsImgSaPath?: string; // 간편인증 이미지 경로
  brandIconImg?: string; // 브랜드 아이콘 이미지
  mmsBrandThumImg?: string; // 브랜드 MMS 썸네일 이미지
  mmsGoodsImg?: string; // 상품 MMS 이미지
  goodsExpl?: string; // 상품 설명
  sellDisCntCost?: string; // 판매할인비용
  mmsBarcdCreateYn?: string; // MMS 바코드 생성 여부
  mmsContent?: string; // MMS 추가문구
  b2bGoodsYn?: string; // B2B 상품 여부
  riskyGoodsYn?: string; // 위험 상품 여부
  cancelPosblYn?: string; // 취소 가능 여부
  extdPosblYn?: string; // 연장 가능 여부
  refundPosblYn?: string; // 환불 가능 여부
  searchText?: string; // 상품 검색어
  stadTermsApplyYn?: string; // 표준약관 여부
  issuerNm?: string; // 발행자명
  supplyUniqCd?: string; // 상품공급업체코드
  prepayRechagAmtMngtYn?: string; // 선불충전금관리여부
  prepayInsuranceName?: string; // 선불충전금 발급기관명
  correcDtm?: string; // 수정일자
}

export interface GiftiShowAllGoodsOut {
  resCode: string; // 응답코드 (0000=정상)
  resMsg: string; // 응답메시지
  listNum: string; // 리스트 개수
  goodsList: GiftiShowGoodsItem[];
}

export interface IGiftiShow {
  issue(obj: GiftiShowIssueIn): Promise<GiftiShowIssueOut>;

  check(obj: GifitiShowCheckIn): Promise<GiftiShowCheckOut>;

  cancel(obj: GifitiShowCancelIn): Promise<void>;

  getAllGoods(): Promise<GiftiShowAllGoodsOut>;
}
