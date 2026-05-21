-- PR5 Wallet (최종): legacy 컬럼 DROP
-- 실행 조건 (PR5 머지 직전 staging dry-run + prod 적용):
--   1. PR1a~PR4 develop 머지 완료
--   2. ESLint allowlist 비어있음 (`npm run lint` 통과 + .eslintrc.js overrides 6 caller 빈 배열)
--   3. external_api 이관 완료 (resolvePayableResource() 활성 + isSettleBalance 응답 deprecated)
--   4. wallet_account 무드리프트 (backfill SUM 검증 통과 staging 1주)
--   5. 백업 완료
--
-- ─── 사전 검증 SQL (별도 실행) ─────────────────────────────────────
-- SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'wallet_account';  -- = 1
-- SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'wallet_transaction'; -- = 1
-- SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'order_payment_allocation'; -- = 1
-- SELECT IFNULL(SUM(deposit_balance), 0) FROM wallet_account; -- == Σ user.balance + Σ user_company.balance
--
-- ─── DROP 실행 (위 검증 통과 후) ────────────────────────────────────
-- 단일 트랜잭션 (MySQL 8.0+ DDL atomic 보장 안 됨 → 단계별 실행 + 각 단계 rollback 시 RENAME 으로 복원)
--
-- Phase 1: RENAME (안전 단계). 1주 모니터링 후 Phase 2 DROP.
ALTER TABLE `user`
  CHANGE COLUMN `balance` `legacy_balance` INT NOT NULL DEFAULT 0 COMMENT 'PR5 DEPRECATED, deferred DROP',
  CHANGE COLUMN `allSettleAmount` `legacy_all_settle_amount` INT NOT NULL DEFAULT 0 COMMENT 'PR5 DEPRECATED, deferred DROP';

ALTER TABLE `user_company`
  CHANGE COLUMN `balance` `legacy_balance` INT NOT NULL DEFAULT 0 COMMENT 'PR5 DEPRECATED, deferred DROP',
  CHANGE COLUMN `balanceManagementType` `legacy_balance_management_type` VARCHAR(20) NOT NULL DEFAULT 'COMPANY' COMMENT 'PR5 DEPRECATED, deferred DROP';

ALTER TABLE `order`
  CHANGE COLUMN `isSettleBalance` `legacy_is_settle_balance` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'PR5 DEPRECATED, deferred DROP',
  CHANGE COLUMN `isCreditExcess` `legacy_is_credit_excess` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'PR5 DEPRECATED, deferred DROP';

-- ─── Phase 2: 최종 DROP (Phase 1 적용 + 1주 모니터링 무이상 후 별도 마이그레이션) ─
-- 별 파일 (`20260601_pr5_drop_legacy_columns_final.sql`) 로 분리 예정.
-- ALTER TABLE `user` DROP COLUMN `legacy_balance`, DROP COLUMN `legacy_all_settle_amount`;
-- ALTER TABLE `user_company` DROP COLUMN `legacy_balance`, DROP COLUMN `legacy_balance_management_type`;
-- ALTER TABLE `order` DROP COLUMN `legacy_is_settle_balance`, DROP COLUMN `legacy_is_credit_excess`;
--
-- 실행 시 ESLint 규칙도 제거 (`.eslintrc.js` no-restricted-properties 블록 삭제).
-- entity 정의의 deprecated 컬럼도 삭제 + database.module 등록 정리.
