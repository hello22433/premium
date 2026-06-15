/**
 * SsgRecoveryService.recoverWithLease 결과.
 * docs/plans/2026-06-12-external-api-wallet-integration.md B-0~B-7.
 *
 * lease 게이트(CAS token claim) + resolver(B-6 멱등) 를 결합한 단일 진입점의 결과.
 *
 * - SKIPPED_NO_CLAIM : CAS claim affected=0 → 다른 actor 소유 중이거나 이미 settled. 복구 시도 안 함.
 * - RESTORED         : claim 소유 후 resolver 가 RESTORED (행사 잔액 복구 발생).
 * - SKIPPED_CONFIRMED: claim 소유 후 resolver 가 SKIPPED_CONFIRMED (CONFIRMED → 복구 불필요).
 * - DEFERRED         : claim 소유했으나 resolver 가 DEFERRED. settled=false 유지 → lease 만료 후 재claim 대상.
 */
export enum SsgRecoveryResult {
  SKIPPED_NO_CLAIM = 'SKIPPED_NO_CLAIM',
  RESTORED = 'RESTORED',
  SKIPPED_CONFIRMED = 'SKIPPED_CONFIRMED',
  DEFERRED = 'DEFERRED',
}
