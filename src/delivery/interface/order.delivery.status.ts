export enum IOrderDeliveryStatus {
  TEMP = 'TEMP',
  WAIT = 'WAIT',
  CANCEL = 'CANCEL',
  COMPLETE = 'COMPLETE',
  FAIL = 'FAIL',
  COMPLETE_SMS = 'COMPLETE_SMS', // 알림톡 불가로 SMS 로 전송이 성공한 경우
  FAIL_SMS = 'FAIL_SMS', // 알림톡 불가로 SMS 로 전송이 실패한 경우
}
