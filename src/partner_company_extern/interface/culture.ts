export interface CultureIssueIn {
  transactionId: string;
  partnerCompanyCode: string;
  expireDay: number;
  price: number;
}

export interface CultureCancelIn {
  barCode: string;
  expireDay: number;
  certNo: string; // 상품권 관리번호 — cancel 실패 시 check 멱등 검증용
}

export interface CultureCheckIn {
  scrachNo: string; // 상품권 핀 번호(16자리)
  certNo: string; // 상품권 관리번호(16자리)
  requestAt?: Date; // 요청 일시(미지정 시 new Date())
  expireDay: number; // 만료일 구분(60일/90일 등)
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

// 컬쳐랜드 일대사(Daily Batch) 요청 DTO - 60일 상품 전용
export interface CultureCheckDailyIn {
  useDate?: string; // 사용일 (YYYYMMDD), 기본값: 어제
}

// 컬쳐랜드 일대사(Daily Batch) 응답 DTO
export interface CultureCheckDailyOut {
  memberCode: string; // 구매처 코드
  subMemberCode: string; // 구매처 판매점코드
  useDate: string; // 사용일 (YYYYMMDD)
  certNoList: string[]; // 사용된 상품권 관리번호 목록
}

export interface ICulture {
  issue(obj: CultureIssueIn): Promise<CultureIssueOut>;

  cancel(obj: CultureCancelIn): Promise<void>;

  check(obj: CultureCheckIn): Promise<CultureCheckOut>;

  /**
   * 일대사(Daily Batch) - 60일 상품 전용
   * 전날 사용된 상품권 목록 조회
   */
  checkDaily(obj: CultureCheckDailyIn): Promise<CultureCheckDailyOut>;
}
