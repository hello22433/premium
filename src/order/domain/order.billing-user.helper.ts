/**
 * 주문의 billing user(실 과금 대상 user) id 를 반환한다.
 *
 * 대행주문(`clientUserId IS NOT NULL`) 의 경우 `clientUserId` 가 외상 누계 / 잔액 mirror 의
 * 대상이고, 일반 주문은 `userId` 가 대상이다. 코드베이스 전체에서 동일한 패턴
 * `const billingUserId = order.clientUserId ?? order.userId;` 를 사용하므로 본 헬퍼로 통일한다.
 *
 * Wallet Cutover Bundle(plan v2.1) F-002. PR3 정산 mirror 와 PR2 보상 release 시 사용.
 */
export function getBillingUserId(order: Pick<{ userId: number; clientUserId: number | null }, 'userId' | 'clientUserId'>): number {
  return order.clientUserId ?? order.userId;
}
