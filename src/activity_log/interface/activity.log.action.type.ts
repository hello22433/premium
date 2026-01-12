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
  MAXIMUM_LIMIT_MODIFY = 'MAXIMUM_LIMIT_MODIFY', // 최대서비스한도(여신한도) 수정
  DELIVERY_COMPLETE_REPORT = 'DELIVERY_COMPLETE_REPORT', // 발송완료리포트 다운로드
  TRANSACTION_STATEMENT = 'TRANSACTION_STATEMENT', // 거래명세서 다운로드
}
