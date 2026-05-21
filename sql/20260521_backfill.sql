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

BEGIN;

-- 1. 모든 user에 settlement_code 부여 (회사 단위 공유)
UPDATE `user` u
  JOIN `user_company` c ON u.company_id = c.id
   SET u.settlement_code = CONCAT('company-', c.id)
 WHERE u.settlement_code = ''
   AND u.company_id IS NOT NULL;

-- 2. wallet_account 생성 (회사 단위, 멱등)
--    NOT EXISTS 가드로 재실행 가능 (PR2 진입 시 drift 정정용 재실행 대비)
INSERT INTO `wallet_account` (
  `owner_type`, `owner_id`,
  `deposit_balance`, `credit_limit`,
  `credit_used_amount`, `credit_excess_amount`
)
SELECT
  'SETTLEMENT_CODE',
  CONCAT('company-', c.id),
  IFNULL(c.balance, 0) + IFNULL(
    (SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = c.id),
    0
  ),
  IFNULL(c.maximumLimit, 0),
  0, -- credit_used_amount: legacy 미존재. PR2 발송확정에서 누적
  0  -- credit_excess_amount: legacy 미존재. PR2 발송확정에서 누적
FROM `user_company` c
WHERE NOT EXISTS (
  SELECT 1 FROM `wallet_account` w
   WHERE w.owner_type = 'SETTLEMENT_CODE'
     AND w.owner_id = CONCAT('company-', c.id)
);

-- 3. 검증 (verified columns only)
-- 3-1. deposit 보존
SELECT
  (SELECT IFNULL(SUM(balance), 0) FROM `user`) +
  (SELECT IFNULL(SUM(balance), 0) FROM `user_company`) AS legacy_deposit,
  (SELECT IFNULL(SUM(deposit_balance), 0) FROM `wallet_account`) AS wallet_deposit;

-- 3-2. credit_limit 보존
SELECT
  (SELECT IFNULL(SUM(maximumLimit), 0) FROM `user_company`) AS legacy_credit_limit,
  (SELECT IFNULL(SUM(credit_limit), 0) FROM `wallet_account`) AS wallet_credit_limit;

-- 3-3. credit_used / credit_excess wallet=0 검증
SELECT
  (SELECT IFNULL(SUM(credit_used_amount), 0) FROM `wallet_account`) AS wallet_credit_used_should_be_0,
  (SELECT IFNULL(SUM(credit_excess_amount), 0) FROM `wallet_account`) AS wallet_credit_excess_should_be_0;

-- 3-4. settlement_code 중복 검증 (0 row 반환이어야 함)
SELECT owner_type, owner_id, COUNT(*) AS dup_cnt
  FROM `wallet_account`
 GROUP BY owner_type, owner_id
HAVING COUNT(*) > 1;

-- 각 쌍 일치 (deposit + credit_limit) + credit_used/excess = 0 + dup 0 확인 후
COMMIT;
-- 불일치 시 ROLLBACK + 운영 알림
