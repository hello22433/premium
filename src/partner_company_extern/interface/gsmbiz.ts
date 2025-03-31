// application server 에서 갤럭시아 측에 보내는 object dto
export interface GsmBizIssueIn {
  transactionId: string; // Clico_Issu_Paym_No
  partnerCompanyCode: string; // Issu_Req_Val
}

export interface GsmBizCheckIn {
  transactionId: string; // Clico_Issu_Paym_No
  partnerCompanyCode: string; // Issu_Req_Val
  barCode: string;
}

export interface GsmBizCancelIn {
  transactionId: string; // Clico_Issu_Paym_No
  partnerCompanyCode: string; // Issu_Req_Val
  barCode: string;
}

// 갤럭시아 측에서 application server 로 받은 object dto
export interface GsmBizIssueOut {
  returnCode: string;
  returnMsg: string;
  couponInfo: {
    cupn_No: string;
    avlStart_Dy: string;
    avl_End_Dy: string;
    appr_Url: string;
    barCode: string;
  };
}

export interface GsmBizCheckOut {
  returnCode: string;
  returnMsg: string;
  couponInfo: {
    STATE: string;
    cupn_No: string;
    avlStart_Dy: string;
    avl_End_Dy: string;
    appr_Url: string;
    barCode: string;
    USE_DT: string;
  };
}

export interface IGsmbiz {
  issue(obj: GsmBizIssueIn): Promise<GsmBizIssueOut>;

  check(obj: GsmBizCheckIn): Promise<GsmBizCheckOut>;

  cancel(obj: GsmBizCancelIn): Promise<void>;
}
