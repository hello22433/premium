// application server 에서 갤럭시아 측에 보내는 object dto
export interface GalaxiaIssueIn {
  transactionId: string; // order-number
  partnerCompanyCode: string; // goodsGroupid
  fromPhoneNumber: string; //buyer
  giftKind: 'cpn' | 'dept'; // coupon : cpn, 상품권 : dept
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

export interface IGalaxia {
  issue(obj: GalaxiaIssueIn): Promise<GalaxiaIssueOut>;
}
