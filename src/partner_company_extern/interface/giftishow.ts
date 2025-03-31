export interface GiftiShowIssueIn {
  transactionId: string; // Clico_Issu_Paym_No
  partnerCompanyCode: string; // Issu_Req_Val
}

export interface GifitiShowCheckIn {
  transactionId: string;
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

export interface GiftiShowCheckOut {
  response: {
    result: { code: string[]; reason: string[]; StatusCode: string[]; StatusText: string[]; remainAmt: string[] }[];
  };
}

export interface IGiftiShow {
  issue(obj: GiftiShowIssueIn): Promise<GiftiShowIssueOut>;

  check(obj: GifitiShowCheckIn): Promise<GiftiShowCheckOut>;

  cancel(obj: GifitiShowCancelIn): Promise<void>;
}
