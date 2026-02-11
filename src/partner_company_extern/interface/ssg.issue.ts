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

export type ISsgCheckIn = {
  eventNo: string;
  eventSeq: number;
  vno: string;
};

export type ISsgIssueOut = {
  response: {
    result: {
      code: string[]; // 코드 값
      reason: string[]; // 응답 메시지
    }[];
  };
};

export type ISsgCheckOut = {
  response: {
    result: {
      code: string[]; // 코드 값
      reason: string[]; // 응답 메시지
    }[];
    value: {
      event_no: string[];
      event_seq: string[];
      vno: string[];
      executeDate: string[];
      resultCd: string[]; // resultCd '0100' 일 때 정상(발행) '0400' 일 때 지급(교환)
      result: string[];
      payaccntNm: string[];
      trId: string[];
    }[];
  };
};

export interface ISsgIssue {
  generateSsgIssue(): ISsgIssueCode;

  issue(obj: ISsgIssueIn): Promise<ISsgIssueOut>;

  check(obj: ISsgCheckIn): Promise<ISsgCheckOut>;
}
