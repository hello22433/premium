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
  ResultCode: string;
  ResultMsg: string;
  CouponNum: string;
  AccountYn: 'Y' | 'C'; // Y 정상 발급, C 발급 취소
  UseYn: 'Y' | 'N'; // Y 사용 완료 N 미사용
  UseDate: string;
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
