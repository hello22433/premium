export interface GiftielIssueIn {
  transactionId: string; // CouponCode
  partnerCompanyCode: string; // SeqNumber
}

export interface GiftielIssueOut {
  ResultCode: string;
  ResultMsg: string;
  CouponList: [
    {
      CouponNum: string;
      PinNumber: string;
      DayStart: string;
      DayEnd: string;
      SendHp: string;
      BalChkUrl: string;
    },
  ];
}

export interface GiftielCheckOut {
  ResultCode: string; // 처리 결과 코드
  ResultMsg: string; // 처리 메시지

  CouponNum: string; // 쿠폰번호
  CnName: string; // 상품명
  CnPrice: string; // 소비자가격

  AccountYn: 'Y' | 'C'; // Y: 정상발급, C: 발급취소
  SendGubun: 'B' | 'C' | 'O'; // B:B2B, C:B2C, O:온라인몰

  UseYn: 'Y' | 'N'; // Y: 사용, N: 미사용
  UseDate: string; // 사용일자(yyyy-MM-dd) - 문서는 HH:mm:ss 포함이라고 되어 있으나 실제 응답은 날짜만 옴. 초단위는 push(L1 webhook)의 AuthDate 참조
  BiName: string; // 사용매장명

  IsCancel: 'Y' | 'N'; // 취소 가능 여부
  DayStart: string; // 유효기간 시작(yyyy-MM-dd)
  DayEnd: string; // 유효기간 종료(yyyy-MM-dd)

  CouponType: '00' | '02'; // 00:교환/할인권, 02:금액권
  CouponBalance: string; // 잔액
  BalChkUrl: string; // 잔액조회 URL
}

export interface GiftielCancelIn {
  partnerCompanyCode: string; // CouponCode
  barCode: string;
}

export interface GiftielCheckIn {
  partnerCompanyCode: string; // CouponCode
  barCode: string; // CouponNum
}

export interface IGiftiel {
  issue(obj: GiftielIssueIn): Promise<GiftielIssueOut>;

  check(obj: GiftielCheckIn): Promise<GiftielCheckOut>;

  cancel(obj: GiftielCancelIn): Promise<void>;
}
