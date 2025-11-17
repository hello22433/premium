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
  cpnStatus?: string; // CPN_STATUS - 쿠폰상태 (00: 미사용, 01: 교환완료, 02: 기취소)
  useDate?: string; // USE_DATE - 사용일자
  useBranch?: string; // USER_STORE - 사용처
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

// 다우기술 API XML 응답 파싱용 DTO
export interface DaouXmlResponse {
  RT?: string; // 결과코드
  RTMSG?: string; // 결과메시지
  NO_CPN?: string; // 쿠폰번호
  TS_ID?: string; // 파트너키
  CPN_STATUS?: string; // 쿠폰상태
  USE_DATE?: string; // 사용일자
  USER_STORE?: string; // 사용처
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
}
