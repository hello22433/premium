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

export type ISsgTryIn = {
  vno: string; // SSG cust_info.HP = personalCode (개인번호)
};

/**
 * GetSsgTry.do 원시 응답 (cust_info 시도내역 조회).
 * 성공 시에만 value 블록이 채워진다(tryYn). 에러(검증 실패 등) 시 result.code 만 존재.
 */
export type ISsgTryOut = {
  response: {
    result: {
      code: string[];
      reason: string[];
    }[];
    value?: {
      vno: string[];
      tryYn: string[]; // 'Y' = cust_info 에 제출 이력 있음, 'N' = 없음
      tryCnt?: string[];
      lastTryDate?: string[];
      setAmt?: string[];
      custNm?: string[];
      trId?: string[];
    }[];
  };
};

/**
 * SSG PIN 판정 — GetSsgTry(cust_info 제출여부) + GetSsgStatus(cust_info_result 결과/유효성) 조합.
 */
export enum SsgPinVerdict {
  NOT_SUBMITTED = 'NOT_SUBMITTED', // cust_info 에 없음 → 새 PIN INSERT
  PROCESSING = 'PROCESSING', // cust_info 있으나 result 없음 → SSG 처리중 → 보류
  REGISTERED = 'REGISTERED', // result 유효(0100/0200/0400) → 기존 PIN 재사용
  REGISTRATION_FAILED = 'REGISTRATION_FAILED', // result 등록실패(01XX≠00) → 새 PIN INSERT
}
/**
 * SSG PIN 후보 조회와 고아 복구가 공유하는 보수적 판정 결과.
 * NOT_ISSUED는 SSG의 공식 미존재 계약이 증명될 때만 사용한다.
 */
export enum SsgPinResolution {
  CONFIRMED = 'CONFIRMED',
  NOT_ISSUED = 'NOT_ISSUED',
  PROCESSING = 'PROCESSING',
  UNKNOWN = 'UNKNOWN',
  MULTIPLE_CONFIRMED = 'MULTIPLE_CONFIRMED',
}

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

  getTry(obj: ISsgTryIn): Promise<ISsgTryOut>;

  getAmount(obj: ISsgAmountIn): Promise<ISsgAmountResult>;
}
