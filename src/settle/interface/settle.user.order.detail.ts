export enum SettleUserOrderDetailEnum {
  UNSETTLE_OVERDUE = 'UNSETTLE_OVERDUE', // 미정산(초과)
  UNSETTLE_NORMAL = 'UNSETTLE_NORMAL', // 미정산(정상)
  SETTLE_COMPLETE = 'SETTLE_COMPLETE', // 정산완료
}
