-- Wallet 재backfill DRY-RUN (flip 직전 검증용, COMMIT 안 함)
-- =====================================================
-- 목적: 상용 shadow→WALLET flip 직전, write-freeze 창에서 실행할 재backfill
--   (wallet_full_apply.sql SECTION 9) 을 ROLLBACK 으로 미리 돌려 GATE 통과 +
--   검증쿼리 숫자(legacy==wallet) 일치를 확인한다. 순수 검증 — 영속 write 0.
--
-- 실행: mysql --abort-source-on-error <DB> < wallet_rebackfill_dryrun.sql
--   - GATE 가 SIGNAL 로 abort 하면 → 20260527_wallet_legacy_reconcile.sql 로 원인 확인
--     → 운영자 보정 → 재실행.
--   - GATE 통과 시 verification SELECT 4종 출력:
--       3-1 legacy_deposit == wallet_deposit
--       3-2 legacy_credit_limit == wallet_credit_limit
--       3-3 legacy_all_settle_amount == wallet_credit_used
--       3-3b wallet_credit_excess_should_be_0 == 0
--       3-4 dup row 0건
--   - 위 일치 확인 후, 실제 flip 시에는 wallet_full_apply.sql SECTION 9 (COMMIT 판) 를
--     freeze 창 안에서 실행한다.
--
-- ⚠️ 이 파일은 마지막을 ROLLBACK 으로 둬 절대 commit 안 함. 실제 적용본 아님.

-- ============================================================================
-- GATE: legacy cleansing 검증 (wallet_full_apply.sql 와 동일)
-- ============================================================================
DROP PROCEDURE IF EXISTS check_legacy_clean_for_backfill;
DELIMITER //
CREATE PROCEDURE check_legacy_clean_for_backfill()
BEGIN
  DECLARE negative_count INT DEFAULT 0;
  DECLARE drift_user_count INT DEFAULT 0;
  DECLARE over_limit_company_count INT DEFAULT 0;

  SELECT COUNT(*) INTO negative_count
    FROM `user`
   WHERE all_settle_amount < 0;

  SELECT COUNT(*) INTO drift_user_count
    FROM (
      WITH order_active AS (
        SELECT
          COALESCE(o.client_user_id, o.user_id) AS billing_user_id,
          o.settle_amount
        FROM `order` o
        WHERE o.status NOT IN ('TEMP', 'DELIVERY_CANCEL', 'DELETED')
          AND o.is_settle_complete = 0
          AND (o.is_settle_balance = 0 OR o.is_credit_excess = 1)
      ),
      expected_per_user AS (
        SELECT billing_user_id, SUM(settle_amount) AS expected_all_settle
          FROM order_active GROUP BY billing_user_id
      )
      SELECT u.id
        FROM `user` u
        LEFT JOIN expected_per_user e ON e.billing_user_id = u.id
       WHERE ABS(u.all_settle_amount - COALESCE(e.expected_all_settle, 0)) >= 100000
    ) t;

  SELECT COUNT(*) INTO over_limit_company_count
    FROM (
      SELECT c.id
        FROM `user_company` c
        JOIN `user` u ON u.company_id = c.id
       GROUP BY c.id, c.maximum_limit
      HAVING SUM(u.all_settle_amount) > c.maximum_limit
    ) t;

  IF negative_count > 0 OR drift_user_count > 0 OR over_limit_company_count > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      CONCAT(
        'legacy cleansing required before wallet backfill: negative_users=', negative_count,
        ' drift_users=', drift_user_count,
        ' over_limit_companies=', over_limit_company_count,
        '. 20260527_wallet_legacy_reconcile.sql 실행 후 운영자 보정 → 재실행.'
      );
  END IF;
END //
DELIMITER ;

CALL check_legacy_clean_for_backfill();
DROP PROCEDURE IF EXISTS check_legacy_clean_for_backfill;

-- ============================================================================
-- 재backfill 본문 (GATE 통과 후 도달) — DRY-RUN: ROLLBACK 으로 종료
-- ============================================================================
BEGIN;

-- 1. settlement_code 부여 (이미 부여돼 있으면 no-op)
UPDATE `user` u
  JOIN `user_company` c ON u.company_id = c.id
   SET u.settlement_code = CONCAT('company-', c.id)
 WHERE u.settlement_code = ''
   AND u.company_id IS NOT NULL;

-- 2. wallet_account 멱등 재동기 (deposit/credit_limit/credit_used 갱신)
INSERT INTO `wallet_account` (
  `owner_type`, `owner_id`,
  `deposit_balance`, `credit_limit`,
  `credit_used_amount`, `credit_excess_amount`,
  `settle_condition`, `settle_method`
)
SELECT
  'SETTLEMENT_CODE',
  CONCAT('company-', c.id),
  IFNULL(c.balance, 0) + IFNULL(
    (SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = c.id), 0),
  IFNULL(c.maximum_limit, 0),
  IFNULL(
    (SELECT SUM(u.all_settle_amount) FROM `user` u WHERE u.company_id = c.id), 0),
  0,
  IFNULL(
    (SELECT u.settle_condition FROM `user` u WHERE u.company_id = c.id ORDER BY u.id ASC LIMIT 1),
    'POST_PAYMENT'),
  IFNULL(
    (SELECT u.settle_method FROM `user` u WHERE u.company_id = c.id ORDER BY u.id ASC LIMIT 1),
    'CASH')
FROM `user_company` c
ON DUPLICATE KEY UPDATE
  deposit_balance = IFNULL(c.balance, 0) + IFNULL(
    (SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = c.id), 0),
  credit_limit = IFNULL(c.maximum_limit, 0),
  credit_used_amount = IFNULL(
    (SELECT SUM(u.all_settle_amount) FROM `user` u WHERE u.company_id = c.id), 0);

-- 검증 3-1. deposit 보존 (legacy_deposit == wallet_deposit)
SELECT
  (SELECT IFNULL(SUM(balance), 0) FROM `user`) +
  (SELECT IFNULL(SUM(balance), 0) FROM `user_company`) AS legacy_deposit,
  (SELECT IFNULL(SUM(deposit_balance), 0) FROM `wallet_account`) AS wallet_deposit;

-- 검증 3-2. credit_limit 보존
SELECT
  (SELECT IFNULL(SUM(maximum_limit), 0) FROM `user_company`) AS legacy_credit_limit,
  (SELECT IFNULL(SUM(credit_limit), 0) FROM `wallet_account`) AS wallet_credit_limit;

-- 검증 3-3. credit_used 보존 (legacy_all_settle_amount == wallet_credit_used)
SELECT
  (SELECT IFNULL(SUM(all_settle_amount), 0) FROM `user`) AS legacy_all_settle_amount,
  (SELECT IFNULL(SUM(credit_used_amount), 0) FROM `wallet_account`) AS wallet_credit_used;

-- 검증 3-3b. credit_excess == 0
SELECT
  (SELECT IFNULL(SUM(credit_excess_amount), 0) FROM `wallet_account`) AS wallet_credit_excess_should_be_0;

-- 검증 3-4. settlement_code 중복 (0 row)
SELECT owner_type, owner_id, COUNT(*) AS dup_cnt
  FROM `wallet_account`
 GROUP BY owner_type, owner_id
HAVING COUNT(*) > 1;

-- DRY-RUN: 영속 write 0
ROLLBACK;
