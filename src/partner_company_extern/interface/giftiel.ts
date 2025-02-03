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

export interface IGiftiel {
  issue(obj: GiftielIssueIn): Promise<GiftielIssueOut>;
}
