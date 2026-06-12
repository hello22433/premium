export interface ErpZoneExternOut {
  Status: number | string; // 처리 상태 (예: 200) — ecount 는 number, 방어적으로 string 도 허용
  Error: ApiError; // 오류 정보 (오류 발생 시 존재)
  Data: ApiData; // 결과 데이터 (존재할 경우)
}

export interface ApiError {
  Code?: string; // 오류 코드
  Message?: string; // 오류 내용
  MessageDetail?: string; // 오류 상세정보
}

export interface ApiData {
  ZONE: string; // Sub domain Zone (로그인 API 호출시 사용될 Zone)
  DOMAIN: string; // Domain (로그인 API 호출시 사용될 도메인)
  EXPIRE_DATE: string; // API 현재 버전 서비스 종료 날짜
}
