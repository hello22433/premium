export enum ActivityLogActionType {
  EXCEL_DOWNLOAD = 'EXCEL_DOWNLOAD', // 엑셀 다운로드
  LOGIN = 'LOGIN', // 로그인
  LOGOUT = 'LOGOUT', // 로그아웃
  PASSWORD_CHANGE = 'PASSWORD_CHANGE', // 비밀번호 변경
  DATA_EXPORT = 'DATA_EXPORT', // 데이터 내보내기
  DATA_IMPORT = 'DATA_IMPORT', // 데이터 가져오기
  CREATE = 'CREATE', // 생성
  UPDATE = 'UPDATE', // 수정
  DELETE = 'DELETE', // 삭제
  BALANCE_CHARGE = 'BALANCE_CHARGE', // 선충전 잔액 충전
  BALANCE_MODIFY = 'BALANCE_MODIFY', // 선충전 잔액 수정 (최고관리자)
}
