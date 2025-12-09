// application server 에서 갤럭시아 측에 보내는 object dto
export interface GalaxiaIssueIn {
  transactionId: string; // order-number
  partnerCompanyCode: string; // goodsGroupid
  fromPhoneNumber: string; //buyer
  giftKind: 'cpn' | 'dept'; // coupon : cpn, 상품권 : dept
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
}
