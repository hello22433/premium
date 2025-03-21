export type ISsgIssueCode = {
  barCode: string;
  personalCode: string;
};

export type ISsgIssueIn = {
  eventNo: string;
  eventSeq: number;
  eventKey: string;
  vno: string;
  pinNo: string;
  userName: string;
  userAmount: string;
  msgContent: string;
  trId: string;
  callBack: string;
};

export type ISsgIssueOut = {
  response: {
    result: {
      code: string[]; // 코드 값
      reason: string[]; // 응답 메시지
    }[];
  };
};

export interface ISsgIssue {
  generateSsgIssue(): ISsgIssueCode;

  issue(obj: ISsgIssueIn): Promise<any>;
}
