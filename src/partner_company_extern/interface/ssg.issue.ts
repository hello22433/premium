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

export type ISsgAmountIn = {
  eventNo: string;
  eventSeq: number;
};

/**
 * GetSsgAmount.do 원시 응답.
 * 서버 XML value 태그는 camelCase(eventNo/eventSeq/tryAmt/successAmt/failAmt) 이며 xml2js로 string[] 파싱된다.
 * (ISsgCheckOut.value 의 snake_case 와 다르므로 복사하지 말 것)
 */
export type ISsgAmountOut = {
  response: {
    result: {
      code: string[]; // 코드 값
      reason: string[]; // 응답 메시지
    }[];
    value?: {
      eventNo: string[];
      eventSeq: string[];
      tryAmt: string[]; // 주문시도 총액
      successAmt: string[]; // 발급성공 총액
      failAmt: string[]; // 발급실패 총액
    }[];
  };
};

/**
 * getAmount() 의 가공 결과 (호출 측 반환용).
 * pendingAmt = tryAmt - successAmt - failAmt (미처리 금액)
 */
export type ISsgAmountResult = {
  tryAmt: number;
  successAmt: number;
  failAmt: number;
  pendingAmt: number;
};

export interface ISsgIssue {
  generateSsgIssue(): ISsgIssueCode;

  issue(obj: ISsgIssueIn): Promise<ISsgIssueOut>;

  check(obj: ISsgCheckIn): Promise<ISsgCheckOut>;

  getAmount(obj: ISsgAmountIn): Promise<ISsgAmountResult>;
}
