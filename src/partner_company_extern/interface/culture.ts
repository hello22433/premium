export interface CultureIssueIn {
  transactionId: string;
  partnerCompanyCode: string;
  expireDay: number;
  price: number;
}

export interface CultureCancelIn {
  barCode: string;
  expireDay: number;
}

export interface CultureCheckIn {
  barCode: string;
  couponNum: string;
  requestAt: Date;
  expireDay: number;
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

export interface CultureCheckOut {
  HeadNo: string; // 전문 번호 (예: '8220')
  MessageLength: string; // 전문 길이 (예: '0292')
  MemberCode: string; // 구매처 코드
  SubMemberCode: string; // 구매처 판매점코드
  ResultCode: string; // 응답코드 (예: '0000' 정상조회성공, 'XXXX' 에러코드)
  ScrachNo: string; // 상품권 핀 번호
  CertNo?: string; // 상품권 관리 번호 (Optional)
  FaceValue?: number; // 상품권 금액 (액면가, Optional)
  Balance?: number; // 상품권 현재 잔액 (Optional)
  CheckDate?: string; // 조회일자 (YYYYMMDD, Optional)
  CheckTime?: string; // 조회시간 (HHMMSS, Optional)
  ErrMsg?: string; // 에러 메시지 (Optional)
  CancelPossibility?: 'Y' | 'N'; // 상품권 취소 가능 여부 (Y: 취소 가능, N: 취소 불가, Optional)
  Filler: string; // 공백 문자 (166자)
}

export interface ICulture {
  issue(obj: CultureIssueIn): Promise<CultureIssueOut>;

  cancel(obj: CultureCancelIn): Promise<void>;

  check(obj: CultureCheckIn): Promise<CultureCheckOut>;
}
