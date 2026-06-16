export interface ErpLoginOut {
  Data: LoginData; // 응답에 포함된 데이터
  Status: number | string; // 처리 상태 (예: 200) — ecount 는 number, 방어적으로 string 도 허용
  Error: any | null; // 오류 정보 (null 가능)
  Timestamp: string; // 응답 시간이 기록된 타임스탬프
}

export interface LoginData {
  EXPIRE_DATE: string; // API 현재 버전 서비스 종료 날짜
  NOTICE: string; // 공지사항
  Code: string; // 처리 코드 (예: "00" 정상)
  Datas: UserSessionData; // 사용자 세션의 상세 데이터
  Message: string; // 메시지 정보
  RedirectUrl: string; // 리디렉션 URL 정보
}

export interface UserSessionData {
  COM_CODE: string; // 회사 코드
  USER_ID: string; // 사용자 ID
  SESSION_ID: string; // 사용자 세션 ID
}
