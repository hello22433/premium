/**
 * PR2-007 e2e spec — Wallet Cutover Bundle PR2 deliveryConfirmed/cancel.
 *
 * 본 파일은 e2e infrastructure 의 entry point 로만 존재한다.
 * 실제 wallet primitives + idempotency + same-tx rollback 통합 검증은
 *   src/wallet/application/wallet-pr2-delivery-confirm.integration.spec.ts
 * 가 jest unit suite 안에서 수행 (DB 연결 불필요).
 *
 * 진짜 MySQL e2e (typeorm DataSource + 마이그레이션) 는 prod-like DB credential 이 필요해서
 * 본 worktree 에서 자동 실행이 어렵다. 운영 환경에서 다음 단계를 수동으로 수행한다:
 *
 *  1. dev DB 에 마이그레이션 적용 (sql/migrations/20260523_alter_order_payment_allocation_add_released.sql 등).
 *  2. `WALLET_PR2_DELIVERY_LIFECYCLE_MODE=shadow` 로 dev 배포.
 *  3. 주문 lifecycle (발송요청 → 발송확정 → 발송실패환불 → 주문취소) 수동 실행.
 *  4. `wallet_shadow_mismatch` 로그 classification 별 카운트 점검 (real_drift=0 확인).
 *  5. `WALLET_PR2_DELIVERY_LIFECYCLE_MODE=wallet` 로 전환 + lifecycle 회귀.
 *
 * Jest 가 test/jest-e2e.json 으로 본 파일을 발견할 때는 skip 으로 표시.
 * package.json `test:e2e` script 의 `./test/jest-e2 e.json` 경로 오타는 별도 chore PR 에서 수정.
 */

describe('PR2-007 wallet-pr2-delivery-confirm e2e (placeholder)', () => {
  it.skip('manual prod-like e2e — see RUNBOOK section 12', () => {
    expect(true).toBe(true);
  });
});
