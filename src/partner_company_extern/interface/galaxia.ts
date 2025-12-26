// application server 에서 갤럭시아 측에 보내는 object dto
export interface GalaxiaIssueIn {
  transactionId: string; // order-number
  partnerCompanyCode: string; // goodsGroupid
  fromPhoneNumber: string; //buyer
  giftKind: 'cpn' | 'dept'; // coupon : cpn, 상품권 : dept
  faceValue?: string; // 발행 액면가 (백화점 상품권 필수)
}

export interface GalaxiaCheckIn {
  giftKind: 'cpn' | 'dept'; // 쿠폰/상품권 구분: coupon(cpn) | 상품권(dept)
  paramValue: string; // 조회 대상 값 – trId(거래번호) 또는 order-number
  /**
   * 어떤 값을 보낼지 선택
   * 0: transactionId(= trId, 기본)
   * 1: order-number
   */
  paramKind?: 0 | 1;
}

export interface GalaxiaCancelIn {
  transactionId: string; // order-number
  sendRequestAt: number; //issueDay
  giftKind: 'cpn' | 'dept'; // coupon : cpn, 상품권 : dept
  trId: string; // 갤럭시아 고유 trid
}

/**
 * 일대사(Daily Batch) 조회 API
 * URL: /interface/mkt/{company-code}/{giftKind}/checklist
 * 참고: GalaxiaManagerImpl.java galaxiaCoupon_daily()
 */
export interface GalaxiaCheckDailyIn {
  giftKind: 'cpn' | 'dept'; // 쿠폰(cpn) / 백화점 상품권(dept)
  targetDay?: string; // YYYYMMDD 형식, 기본값: 어제
}

/**
 * 일대사 거래 항목
 * 참고: GalaxiaTransactionItem.java
 */
export interface GalaxiaTransactionItem {
  appDiv: string; // 거래구분
  barcode: string; // 바코드 (복호화된 값)
  appDay: string; // 사용일자 (YYYYMMDD)
  appTime: string; // 사용시간 (HHmmss)
  amount: string; // 금액
  appNo: string; // 승인번호
  appStore: string; // 사용처(교환처)
}

export interface GalaxiaCheckDailyOut {
  resCode: string;
  resMsg: string;
  transactions: GalaxiaTransactionItem[];
}

// 갤럭시아 측에서 application server 로 받은 object dto
export interface GalaxiaIssueOut {
  resCode: string;
  resMsg: string;
  transactionId: string;
  giftCertificate: {
    issueNumber: string;
    issueDate: string;
    faceValue: string;
    pinNumber: string;
    barcode: string;
    validTo: string;
  };
}

export interface GalaxiaCheckOut {
  resCode: string;
  resMsg: string;
  transactionId: string | null; // check 응답에는 transactionId가 없을 수 있음
  giftCertificate: {
    couponStatus: 'ACTIVE' | 'CANCEL' | 'INACTIVE';
    isUsed: boolean;
    isRevocable: string;
    validTo: string;
    usedDate: string;
    faceValue: string;
    balance: string;
  };
}

export interface IGalaxia {
  issue(obj: GalaxiaIssueIn): Promise<GalaxiaIssueOut>;

  check(obj: GalaxiaCheckIn): Promise<GalaxiaCheckOut>;

  cancel(obj: GalaxiaCancelIn): Promise<void>;

  /**
   * 일대사(Daily Batch) 조회 - 전날 사용 내역 조회
   * 참고: GalaxiaManagerImpl.java galaxiaCoupon_daily()
   */
  checkDaily(obj: GalaxiaCheckDailyIn): Promise<GalaxiaCheckDailyOut>;
}
