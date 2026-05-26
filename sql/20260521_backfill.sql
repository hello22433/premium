-- PR1a Wallet: legacy → wallet_account backfill
-- consensus plan v4 (verified against user.company.entity.ts:32-44)
-- 컬럼 매핑:
--   user_company.balance       (회사 선충전잔액)
--   + Σ user.balance per company (ACCOUNT 모드도 회사 공유로 합산)
--                              → wallet_account.deposit_balance
--   user_company.maximumLimit  (여신 한도)
--                              → wallet_account.credit_limit
--   credit_used / credit_excess (legacy 미존재)
--                              → 0 (PR2 발송확정에서 누적 시작)
--
-- 모든 user → settlement_code='company-{companyId}' 강제 공유
-- balanceManagementType 분기 폐지 (ACCOUNT 모드 user도 회사 단위 wallet 공유)
--
-- 실행: 단일 트랜잭션. assertion 불일치 시 ROLLBACK + 알림.
-- 사전 게이트: 20260527_wallet_legacy_reconcile.sql 의 검사 항목을 stored proc 에서 재실행해
--   drift / 음수 / over_limit row 가 1개라도 있으면 SIGNAL 로 abort.
--   클린 통과 안 되면 백필 자체가 시작 안 됨 → wallet 시드 오염 사전 차단.
-- 실행 권장: mysql --abort-source-on-error < 20260521_backfill.sql

-- ============================================================================
-- GATE: legacy cleansing 검증
-- ============================================================================
DROP PROCEDURE IF EXISTS check_legacy_clean_for_backfill;
DELIMITER //
CREATE PROCEDURE check_legacy_clean_for_backfill()
BEGIN
  DECLARE negative_count INT DEFAULT 0;
  DECLARE drift_user_count INT DEFAULT 0;
  DECLARE over_limit_company_count INT DEFAULT 0;

  -- 1) 음수 all_settle_amount
  SELECT COUNT(*) INTO negative_count
    FROM `user`
   WHERE all_settle_amount < 0;

  -- 2) 주문 합계 vs all_settle_amount drift (사용자 단위)
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
       WHERE u.all_settle_amount != COALESCE(e.expected_all_settle, 0)
    ) t;

  -- 3) 회사 단위 maximum_limit 초과
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
        '. 20260527_wallet_legacy_reconcile.sql 실행 후 운영자 보정 → 본 SQL 재실행.'
      );
  END IF;
END //
DELIMITER ;

CALL check_legacy_clean_for_backfill();
DROP PROCEDURE IF EXISTS check_legacy_clean_for_backfill;

-- ============================================================================
-- 본 백필 (GATE 통과 후에만 도달)
-- ============================================================================
BEGIN;

-- 1. 모든 user에 settlement_code 부여 (회사 단위 공유)
UPDATE `user` u
  JOIN `user_company` c ON u.company_id = c.id
   SET u.settlement_code = CONCAT('company-', c.id)
 WHERE u.settlement_code = ''
   AND u.company_id IS NOT NULL;

-- 2. wallet_account 생성 (회사 단위, 멱등)
--    NOT EXISTS 가드로 재실행 가능 (PR2 진입 시 drift 정정용 재실행 대비)
--    credit_used_amount = Σ user.allSettleAmount per company (기존 미정산 여신 사용분 이관)
--    credit_excess_amount = 0 (legacy 미존재, PR2 발송확정에서 누적 시작)
--    settle_condition / settle_method: company 안에서 첫 user (id ASC) 의 값 채택.
--    Mixed 인 회사는 운영 확인 필요 (PR3 운영자 UI 에서 별 settlement_code 분리 가능).
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
    (SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = c.id),
    0
  ),
  IFNULL(c.maximum_limit, 0),
  IFNULL(
    (SELECT SUM(u.all_settle_amount) FROM `user` u WHERE u.company_id = c.id),
    0
  ),
  0,  -- credit_excess_amount: legacy 미존재. PR2 발송확정에서 누적
  IFNULL(
    (SELECT u.settle_condition FROM `user` u WHERE u.company_id = c.id ORDER BY u.id ASC LIMIT 1),
    'POST_PAYMENT'
  ),
  IFNULL(
    (SELECT u.settle_method FROM `user` u WHERE u.company_id = c.id ORDER BY u.id ASC LIMIT 1),
    'CASH'
  )
FROM `user_company` c
ON DUPLICATE KEY UPDATE
  -- 재실행 시 deposit / credit_limit / credit_used 만 갱신 (drift 정정).
  -- credit_excess_amount / settle_condition / settle_method 는 발송확정 흐름이 갱신하므로 보존.
  deposit_balance = IFNULL(c.balance, 0) + IFNULL(
    (SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = c.id),
    0
  ),
  credit_limit = IFNULL(c.maximum_limit, 0),
  credit_used_amount = IFNULL(
    (SELECT SUM(u.all_settle_amount) FROM `user` u WHERE u.company_id = c.id),
    0
  );

-- 4. Mixed settleCondition 검증 (운영자 후속 조치 대상 식별)
SELECT c.id AS company_id,
       COUNT(DISTINCT u.settle_condition) AS distinct_conditions,
       GROUP_CONCAT(DISTINCT u.settle_condition) AS conditions
  FROM `user_company` c
  JOIN `user` u ON u.company_id = c.id
 GROUP BY c.id
HAVING COUNT(DISTINCT u.settle_condition) > 1;
-- 위 결과가 1 row 이상이면 운영자가 별 settlement_code 부여 후 wallet 분리 필요 (PR3 UI).

-- 3. 검증 (verified columns only)
-- 3-1. deposit 보존
SELECT
  (SELECT IFNULL(SUM(balance), 0) FROM `user`) +
  (SELECT IFNULL(SUM(balance), 0) FROM `user_company`) AS legacy_deposit,
  (SELECT IFNULL(SUM(deposit_balance), 0) FROM `wallet_account`) AS wallet_deposit;

-- 3-2. credit_limit 보존
SELECT
  (SELECT IFNULL(SUM(maximum_limit), 0) FROM `user_company`) AS legacy_credit_limit,
  (SELECT IFNULL(SUM(credit_limit), 0) FROM `wallet_account`) AS wallet_credit_limit;

-- 3-3. credit_used 보존 (legacy user.allSettleAmount 이관 검증)
SELECT
  (SELECT IFNULL(SUM(all_settle_amount), 0) FROM `user`) AS legacy_all_settle_amount,
  (SELECT IFNULL(SUM(credit_used_amount), 0) FROM `wallet_account`) AS wallet_credit_used;
-- legacy_all_settle_amount == wallet_credit_used 여야 함.

-- 3-3b. credit_excess wallet=0 검증 (legacy 미존재, PR2 에서 누적 시작)
SELECT
  (SELECT IFNULL(SUM(credit_excess_amount), 0) FROM `wallet_account`) AS wallet_credit_excess_should_be_0;

-- 3-4. settlement_code 중복 검증 (0 row 반환이어야 함)
SELECT owner_type, owner_id, COUNT(*) AS dup_cnt
  FROM `wallet_account`
 GROUP BY owner_type, owner_id
HAVING COUNT(*) > 1;

-- 각 쌍 일치 (deposit + credit_limit) + credit_used/excess = 0 + dup 0 확인 후
COMMIT;
-- 불일치 시 ROLLBACK + 운영 알림
