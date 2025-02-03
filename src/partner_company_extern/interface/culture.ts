export interface CultureIssueIn {
  transactionId: string;
  partnerCompanyCode: string;
  expireDay: number; // limitDate:
  price: number;
}

export interface CultureIssueOut {
  HeadNo: string;
  MessageLength: string;
  MemberCode: string;
  SubMemberCode: string;
  ResultCode: string;
  MemberControlCode: string;
  ScrachNo: string;
  CertNo: string;
  ControlCode: string;
  CertType: string;
  FaceValue: string;
  Validity: string;
  LinkURL: string;
  EncScrachNos: string;
  Filler: string;
}

export interface ICulture {
  issue(obj: CultureIssueIn): Promise<CultureIssueOut>;
}
