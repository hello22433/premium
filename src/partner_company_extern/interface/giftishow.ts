export interface GiftiShowIssueIn {
  transactionId: string; // Clico_Issu_Paym_No
  partnerCompanyCode: string; // Issu_Req_Val
}

export interface GiftiShowIssueOut {
  response: {
    result: { code: string[]; reason: string[] }[];
    value: { pin_no: string[]; tr_id: string[]; ctr_id: string[] }[];
  };
}

export interface IGiftiShow {
  issue(obj: GiftiShowIssueIn): Promise<GiftiShowIssueOut>;
}
