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
  BALANCE_REFUND = 'BALANCE_REFUND', // 선충전 잔액 환불 (시스템)
  BALANCE_REFUND_REVERSE = 'BALANCE_REFUND_REVERSE', // 선충전 잔액 환불 복구 (재발송 시 역환불)
  MAXIMUM_LIMIT_MODIFY = 'MAXIMUM_LIMIT_MODIFY', // 최대서비스한도(여신한도) 수정
  DELIVERY_COMPLETE_REPORT = 'DELIVERY_COMPLETE_REPORT', // 발송완료리포트 다운로드
  TRANSACTION_STATEMENT = 'TRANSACTION_STATEMENT', // 거래명세서 다운로드
  DISCARD_RESTORE = 'DISCARD_RESTORE', // 폐기 복구 (선충전 잔액 / 여신)
  PII_SEARCH = 'PII_SEARCH', // 개인정보(수신정보) 검색
  LOGIN_FAIL = 'LOGIN_FAIL', // 로그인 실패
  ACCOUNT_LOCK = 'ACCOUNT_LOCK', // 로그인 5회 실패 계정 잠금
  ACCOUNT_UNLOCK = 'ACCOUNT_UNLOCK', // 계정 잠금 해제 (관리자)
  ACCOUNT_CREATE = 'ACCOUNT_CREATE', // 신규 계정 생성
  ACCOUNT_WITHDRAW = 'ACCOUNT_WITHDRAW', // 탈퇴 (LEAVE 전환 시점)
  ACCOUNT_ANONYMIZE = 'ACCOUNT_ANONYMIZE', // 익명화 (LEAVE +6개월 PII 파기)
}
