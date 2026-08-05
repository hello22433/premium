export enum IPartnerDiscountChangeType {
  CREATE = 'CREATE', // scope 최초 설정 · 삭제 후 재생성
  UPDATE = 'UPDATE', // 값 변경 · 구간 분할 · supersede
  DELETE = 'DELETE', // tombstone — 할인 삭제로 scope 비활성 구간 시작
}
