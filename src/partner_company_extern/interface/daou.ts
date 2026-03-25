// 다우기술 PIN 발급 요청 DTO
export interface DaouIssueIn {
  goodsId: string; // 쿠폰 계약번호(상품번호) - NO_REQ
  transactionId: string; // 제휴처 주문번호 - COOPER_ORDER
  phoneNumber: string; // 발신/수신번호 - CALL_CTN, RCV_CTN
  limitDate: string; // 유효기간 (일수) - VALID_START, VALID_END 계산용
  tradeNo: string; // 거래번호 (PAY_ID, BOOKING_NO 용)
}

// 다우기술 PIN 발급 응답 DTO
export interface DaouIssueOut {
  resultCode: string; // RT - 결과코드 (S000001: 성공)
  resultMessage: string; // RTMSG - 결과메시지
  pinNo?: string; // NO_CPN - 쿠폰번호 (핀번호)
  tsId?: string; // TS_ID - 파트너키
}

// 다우기술 PIN 상태조회 요청 DTO
export interface DaouCheckIn {
  transactionId: string; // 제휴처 주문번호 - COOPER_ORDER
}

// 다우기술 PIN 상태조회 응답 DTO
export interface DaouCheckOut {
  resultCode: string; // RT - 결과코드
  resultMessage: string; // RTMSG - 결과메시지
  cpnStatus?: string; // CPN_STATUS - 쿠폰상태 (00: 미사용, 01: 교환완료, 02: 기취소, 03: 사용중)
  useDate?: string; // USE_DATE - 사용일자
  useBranch?: string; // USE_STORE - 사용처
}

// 다우기술 PIN 취소 요청 DTO
export interface DaouCancelIn {
  pinNo: string; // 쿠폰번호 - NO_CPN
}

// 다우기술 PIN 취소 응답 DTO
export interface DaouCancelOut {
  resultCode: string; // RT - 결과코드
  resultMessage: string; // RTMSG - 결과메시지
}

// 다우기술 전체 상품 정보 조회 요청 DTO (인증 정보는 클래스 내부 사용)
export interface DaouGoodsInfoIn {}

// 다우기술 전체 상품 정보 개별 항목 DTO
export interface DaouGoodsInfoItem {
  reqNo: string; // NO_REQ - 쿠폰 계약번호
  reqName: string; // NM_REQ - 요청명(계약명)
  goodsNo: string; // NO_GOODS - 상품번호
  goodsName: string; // NM_GOODS - 상품명
  goodsCompany: string; // GOODS_COMPANY - 상품사 코드
  goodsCompanyName: string; // NM_GOODS_COMPANY - 상품사명
  goodsPrice: string; // GOODS_PRICE - 상품가격
  cpnPrice: string; // CPN_PRICE - 쿠폰가격
  goodsImage: string; // GOODS_IMAGE - 상품이미지 URL
  category: string; // CATEGORY - 카테고리
  validStart: string; // VALID_START - 유효기간 시작 (임의값)
  validEnd: string; // VALID_END - 유효기간 종료 (임의값)
  siteId: string; // SITE_ID
  goodsCompanyCharge: string; // GOODS_COMPANY_CHARGE (임의값)
  goodsCnt: string; // GOODS_CNT - 상품수량
  discountPrice: string; // DISCOUNT_PRICE - 할인가격 (임의값)
  goodsDiscount: string; // GOODS_DISCOUNT - 제휴처 할인금액 (임의값)
  isChanged: string; // YN_CHANGED - 변경여부 (항상 'N')
  changedDate: string; // CHANGED_DATE - 변경일
  regDate: string; // REG_DATE - 등록일
}

// 다우기술 전체 상품 정보 조회 응답 DTO
export interface DaouGoodsInfoOut {
  resultCode: string; // RT - 결과코드
  resultMessage: string; // RTMSG - 결과메시지
  listCount: number; // LIST_COUNT - 상품 수
  goods: DaouGoodsInfoItem[];
}

// 다우기술 API XML 응답 파싱용 DTO
export interface DaouXmlResponse {
  RT?: string; // 결과코드
  RTMSG?: string; // 결과메시지
  NO_CPN?: string; // 쿠폰번호
  TS_ID?: string; // 파트너키
  CPN_STATUS?: string; // 쿠폰상태 (00: 미사용, 01: 교환완료, 02: 기취소, 03: 사용중)
  USE_DATE?: string; // 사용일자 (YYYYMMDD)
  USE_STORE?: string; // 사용처
}

// 다우기술 서비스 인터페이스
export interface IDaou {
  /**
   * 쿠폰(PIN) 발급
   */
  issue(obj: DaouIssueIn): Promise<DaouIssueOut>;

  /**
   * 쿠폰(PIN) 상태 조회
   */
  check(obj: DaouCheckIn): Promise<DaouCheckOut>;

  /**
   * 쿠폰(PIN) 취소
   */
  cancel(obj: DaouCancelIn): Promise<DaouCancelOut>;

  /**
   * 전체 상품 정보 조회
   */
  goodsInfo(): Promise<DaouGoodsInfoOut>;
}
