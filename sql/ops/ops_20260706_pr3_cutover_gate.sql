-- =============================================================================
-- PR3 (WALLET_PR3_SETTLE_MODE=legacy/shadow → wallet) 전환 직전 GO/NO-GO 게이트
-- 일자: 2026-07-06
-- 성격: READ-ONLY. 데이터 변경 없음. ENV 플립 직전 PROD 에서 1회 실행.
-- 근거: plans/2026-06-30-pr3-settle-read-cutover-runbook.md §2 (P0~P3) 쿼리 정의 그대로.
-- 목적:
--   06-30 reconcile(ops_20260630_pr3_wallet_reconcile.sql)로 데이터 보정 후 shadow 운영.
--   shadow 기간 중 신규 drift 가 쌓였을 수 있으므로, wallet 전환 직전 P0~P3 전제조건을
--   한 번에 재판정한다. 모든 게이트 verdict=PASS 여야 전환 진행.
-- 판정: 각 게이트가 violations=0 / verdict='PASS' 를 반환해야 GO.
--        하나라도 FAIL → 전환 중단, 런북 §2 대응 스크립트로 보정 후 재실행.
-- =============================================================================


-- =============================================================================
-- P0. credit_limit 정합 (wallet.credit_limit == user_company.maximum_limit)
--     FAIL 시: migration/wallet-credit-limit-resync.sql 0~3단계 실행 후 재검.
-- =============================================================================
SELECT 'P0 credit_limit drift' AS gate,
       COUNT(*) AS violations,
       IF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
  FROM (
    SELECT w.id
      FROM wallet_account w
      JOIN `user` u ON u.settlement_code = w.owner_id AND u.deleted_at IS NULL
      JOIN user_company uc ON uc.id = u.company_id
     WHERE w.owner_type = 'SETTLEMENT_CODE'
       AND w.credit_limit <> uc.maximum_limit
     GROUP BY w.id
  ) v;


-- =============================================================================
-- P1-a. 전역 총액 3쌍 일치 (deposit / credit_limit / credit_used)
--       diff<>0 이면 FAIL. deposit 은 COMPANY 모드 phantom user.balance 로 인해
--       잔차가 남을 수 있음(런북 §E / reconcile SECTION E) → P1-b 회사단위로 교차확인.
-- =============================================================================
SELECT 'P1-a deposit total' AS gate,
       legacy_deposit, wallet_deposit,
       wallet_deposit - legacy_deposit AS diff,
       IF(wallet_deposit = legacy_deposit, 'PASS', 'CHECK(§E phantom)') AS verdict
  FROM (
    SELECT (SELECT COALESCE(SUM(balance),0) FROM `user`)
         + (SELECT COALESCE(SUM(balance),0) FROM user_company) AS legacy_deposit,
           (SELECT COALESCE(SUM(deposit_balance),0) FROM wallet_account) AS wallet_deposit
  ) t;

SELECT 'P1-a credit_limit total' AS gate,
       legacy_credit_limit, wallet_credit_limit,
       wallet_credit_limit - legacy_credit_limit AS diff,
       IF(wallet_credit_limit = legacy_credit_limit, 'PASS', 'FAIL') AS verdict
  FROM (
    SELECT (SELECT COALESCE(SUM(maximum_limit),0) FROM user_company) AS legacy_credit_limit,
           (SELECT COALESCE(SUM(credit_limit),0) FROM wallet_account) AS wallet_credit_limit
  ) t;

SELECT 'P1-a credit_used total' AS gate,
       legacy_credit_used, wallet_credit_used,
       wallet_credit_used - legacy_credit_used AS diff,
       IF(wallet_credit_used = legacy_credit_used, 'PASS', 'FAIL') AS verdict
  FROM (
    SELECT (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`) AS legacy_credit_used,
           (SELECT COALESCE(SUM(credit_used_amount),0) FROM wallet_account) AS wallet_credit_used
  ) t;


-- =============================================================================
-- P1-b. 회사단위 deposit drift (런북 §2 P1 회사 단위 쿼리 그대로)
--        legacy = company.balance + SUM(user.balance). COMPANY 모드 phantom 이
--        여기서 잡히면 reconcile §E 로 정리하거나 무해 판정 후 진행.
-- =============================================================================
SELECT 'P1-b company deposit drift' AS gate,
       COUNT(*) AS violations,
       IF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
  FROM (
    SELECT c.id
      FROM user_company c
      LEFT JOIN `user` u ON u.company_id = c.id
      LEFT JOIN wallet_account wa
             ON wa.owner_type = 'SETTLEMENT_CODE'
            AND wa.owner_id = CONCAT('company-', c.id)
     GROUP BY c.id, c.balance
    HAVING MAX(wa.id) IS NULL
        OR MAX(wa.deposit_balance) <> c.balance + COALESCE(SUM(u.balance),0)
  ) v;


-- =============================================================================
-- P2-a. settlement_code 누락 유저
-- =============================================================================
SELECT 'P2-a users w/o settlement_code' AS gate,
       COUNT(*) AS violations,
       IF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
  FROM `user`
 WHERE settlement_code IS NULL OR settlement_code = '';


-- =============================================================================
-- P2-b. wallet_account 누락 유저 (전환 후 fail-closed throw 대상 → 반드시 0)
-- =============================================================================
SELECT 'P2-b users w/o wallet' AS gate,
       COUNT(*) AS violations,
       IF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
  FROM (
    SELECT u.id
      FROM `user` u
      LEFT JOIN wallet_account wa
             ON wa.owner_type = 'SETTLEMENT_CODE'
            AND wa.owner_id = u.settlement_code
     WHERE wa.id IS NULL AND u.deleted_at IS NULL
  ) v;


-- =============================================================================
-- P2-c. wallet_account 중복 (owner_type, owner_id)
-- =============================================================================
SELECT 'P2-c duplicate wallet' AS gate,
       COUNT(*) AS violations,
       IF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
  FROM (
    SELECT owner_type, owner_id
      FROM wallet_account
     GROUP BY owner_type, owner_id
    HAVING COUNT(*) > 1
  ) v;


-- =============================================================================
-- P3. settle_method wallet 백필 정합 (카드할증 default 판정 영향)
--     FAIL 시: migration/settle-method-sot-backfill.sql 로 보정.
-- =============================================================================
SELECT 'P3 settle_method mismatch' AS gate,
       COUNT(*) AS violations,
       IF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
  FROM (
    SELECT w.owner_id
      FROM wallet_account w
      JOIN `user` u ON u.settlement_code = w.owner_id AND u.deleted_at IS NULL
      JOIN user_company uc ON uc.id = u.company_id
     WHERE w.owner_type = 'SETTLEMENT_CODE'
     GROUP BY w.owner_id, w.settle_method
    HAVING w.settle_method IS NULL
        OR FIND_IN_SET(w.settle_method, GROUP_CONCAT(DISTINCT uc.settle_method)) = 0
        OR COUNT(DISTINCT uc.settle_method) > 1
  ) v;


-- =============================================================================
-- 판정: 위 모든 gate verdict='PASS' (P1-a deposit 은 §E phantom 이면 P1-b 로 교차확인).
--   전부 GO → WALLET_PR3_SETTLE_MODE=wallet 로 플립 (런북 §4).
--   하나라도 FAIL → 중단, 해당 대응 스크립트 보정 후 본 게이트 재실행.
-- 추가: shadow 로그 wallet_shadow_mismatch_remain / wallet_shadow_remain_failed 가
--       설명 불가 mismatch 0 인지 별도 확인 (런북 §3, ENV 플립 전제).
-- =============================================================================
