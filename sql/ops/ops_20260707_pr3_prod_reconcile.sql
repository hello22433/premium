-- =============================================================================
-- [PROD] PR3 (WALLET_PR3_SETTLE_MODE=wallet) 전환 선행 reconcile
-- 일자: 2026-07-07
-- 성격: 데이터 변경(deposit 4 + credit_used 1 UPDATE + audit 5 + settle_method 2 UPDATE).
--        write FREEZE 하 실행. parity 게이트 0행 될 때까지. 검증 통과 시에만 COMMIT.
-- 근거: ops_20260707_pr3_parity_gate.sql 진단(2026-07-07) — 4계정 wallet_remain < legacy_remain.
--   company-40 deposit,  company-13 deposit,  company-4 deposit+settle_method,
--   company-2  deposit+credit_used+settle_method.
-- 타깃 (★동적★ — freeze 시점 실측값 사용, 06-30/07-06 하드코딩값 재사용 금지):
--   deposit      → company.balance          (COMPANY 모드 effectiveBalance = legacy 서빙값)
--   credit_used  → Σ user.all_settle_amount (불변식 wallet.credit_used == Σall_settle)
--   settle_method→ company.settle_method     (단순 UPDATE, ledger 불필요)
-- 불변식/판정: ops_20260707_pr3_parity_gate.sql 0행.
--
-- ⚠️ 전제: (1) develop 배포+재시작 완료 (2) PR2=wallet 운영중 (3) write FREEZE (4) DB 백업.
-- ⚠️ company-2 는 500M+ 대형계정 — SECTION B 로 현재값/타깃 육안 확인 후 진행.
-- 멱등: wallet_transaction.idempotency_key UNIQUE.
-- ★ 실행법: auto-commit OFF + stop-on-error ON. 동일 커넥션. B → START TX → C-INSERT → D-a(5행)
--    → C-UPDATE(deposit/credit) → C-SETTLE(settle_method) → D-b → D-c(parity 0행) → COMMIT.
--    C-INSERT(원장) 는 C-UPDATE 전에 실행돼야 amount(=타깃−현재) 가 맞다.
-- =============================================================================


-- =============================================================================
-- SECTION B. 사전검증 — 대상 계정 현재값 + 동적 타깃 (freeze 하 실측)
-- =============================================================================
-- B1. deposit 대상 (wallet.deposit vs company.balance)
SELECT 'B1-deposit' AS chk, w.owner_id, w.id AS wallet_id,
       w.deposit_balance AS cur_deposit, uc.balance AS target_company_balance,
       uc.balance - w.deposit_balance AS delta
  FROM wallet_account w
  JOIN user_company uc ON CONCAT('company-', uc.id) = w.owner_id
 WHERE w.owner_type='SETTLEMENT_CODE'
   AND w.owner_id IN ('company-40','company-13','company-4','company-2')
 ORDER BY w.owner_id;

-- B2. credit_used 대상 (company-2: wallet.credit_used vs Σall_settle)
SELECT 'B2-credit' AS chk, w.owner_id, w.credit_used_amount AS cur_credit_used,
       (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`
         WHERE settlement_code='company-2' AND deleted_at IS NULL) AS target_all_settle
  FROM wallet_account w
 WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-2';

-- B3. settle_method 대상 (company-2/4: wallet vs company)
SELECT 'B3-settle' AS chk, w.owner_id, w.settle_method AS wallet_sm,
       MAX(uc.settle_method) AS company_sm
  FROM wallet_account w
  JOIN `user` u ON u.settlement_code=w.owner_id AND u.deleted_at IS NULL
  JOIN user_company uc ON uc.id=u.company_id
 WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id IN ('company-2','company-4')
 GROUP BY w.owner_id, w.settle_method;


-- =============================================================================
-- START TRANSACTION;   -- ← auto-commit OFF 면 여기서 시작
-- =============================================================================


-- =============================================================================
-- SECTION C-INSERT. 원장 5건 (deposit 4 + credit 1). UPDATE 전, 동적 타깃/현재값으로 amount 산출.
-- =============================================================================
-- deposit 원장 (target = company.balance)
INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
SELECT w.id, NULL, NULL, 'BALANCE_MODIFY', 'DEPOSIT', uc.balance - w.deposit_balance, uc.balance,
       'PR3 PROD reconcile: deposit->company.balance (legacy refund wallet 미동기 backlog)',
       CONCAT('reconcile:pr3:prod:20260707:', w.owner_id, ':deposit'), NOW(6)
  FROM wallet_account w
  JOIN user_company uc ON CONCAT('company-', uc.id) = w.owner_id
 WHERE w.owner_type='SETTLEMENT_CODE'
   AND w.owner_id IN ('company-40','company-13','company-4','company-2')
   AND w.deposit_balance <> uc.balance;

-- credit_used 원장 (company-2, target = Σall_settle)
INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
SELECT w.id, NULL, NULL, 'BALANCE_MODIFY', 'CREDIT',
       t.target - w.credit_used_amount, t.target,
       'PR3 PROD reconcile: credit_used->Σall_settle (백필 과대seed 정정)',
       'reconcile:pr3:prod:20260707:company-2:credit_used', NOW(6)
  FROM wallet_account w
  CROSS JOIN (SELECT COALESCE(SUM(all_settle_amount),0) AS target FROM `user`
               WHERE settlement_code='company-2' AND deleted_at IS NULL) t
 WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-2'
   AND w.credit_used_amount <> t.target;

-- D-a. 원장 건수 확인 (deposit drift 계정수 + credit 1). drift 없는 계정은 INSERT 안 됨.
SELECT 'D-a' AS chk, idempotency_key, resource_type, amount, balance_after
  FROM wallet_transaction
 WHERE idempotency_key LIKE 'reconcile:pr3:prod:20260707:%'
 ORDER BY idempotency_key;
-- expect: deposit 4행(company-40/13/4/2) + credit 1행(company-2) = 5행
--         (진단대로면 5행. 계정별 amount 가 B1/B2 delta 와 일치하는지 확인)


-- =============================================================================
-- SECTION C-UPDATE. 잔액 (D-a 건수/금액 확인 후)
-- =============================================================================
-- deposit → company.balance
UPDATE wallet_account w
  JOIN user_company uc ON CONCAT('company-', uc.id) = w.owner_id
   SET w.deposit_balance = uc.balance
 WHERE w.owner_type='SETTLEMENT_CODE'
   AND w.owner_id IN ('company-40','company-13','company-4','company-2');

-- credit_used → Σall_settle (company-2)
UPDATE wallet_account
   SET credit_used_amount = (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`
                              WHERE settlement_code='company-2' AND deleted_at IS NULL)
 WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-2';


-- =============================================================================
-- SECTION C-SETTLE. settle_method → company SoT (company-2/4, ledger 불필요)
-- =============================================================================
UPDATE wallet_account w
  JOIN `user` u ON u.settlement_code=w.owner_id AND u.deleted_at IS NULL
  JOIN user_company uc ON uc.id=u.company_id
   SET w.settle_method = uc.settle_method
 WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id IN ('company-2','company-4');


-- =============================================================================
-- SECTION D. 사후검증 (COMMIT 전)
-- =============================================================================
-- D-b. 대상 계정 개별 정합
SELECT 'D-b-deposit' AS chk, w.owner_id, w.deposit_balance, uc.balance AS company_balance,
       IF(w.deposit_balance=uc.balance,'PASS','FAIL') AS verdict
  FROM wallet_account w JOIN user_company uc ON CONCAT('company-', uc.id)=w.owner_id
 WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id IN ('company-40','company-13','company-4','company-2')
 ORDER BY w.owner_id;

SELECT 'D-b-credit' AS chk, w.owner_id, w.credit_used_amount,
       (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user` WHERE settlement_code='company-2' AND deleted_at IS NULL) AS all_settle,
       IF(w.credit_used_amount=(SELECT COALESCE(SUM(all_settle_amount),0) FROM `user` WHERE settlement_code='company-2' AND deleted_at IS NULL),'PASS','FAIL') AS verdict
  FROM wallet_account w WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-2';

SELECT 'D-b-settle' AS chk, w.owner_id, w.settle_method AS wallet_sm, MAX(uc.settle_method) AS company_sm,
       IF(FIND_IN_SET(w.settle_method, GROUP_CONCAT(DISTINCT uc.settle_method))>0,'PASS','FAIL') AS verdict
  FROM wallet_account w JOIN `user` u ON u.settlement_code=w.owner_id AND u.deleted_at IS NULL
  JOIN user_company uc ON uc.id=u.company_id
 WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id IN ('company-2','company-4')
 GROUP BY w.owner_id, w.settle_method;

-- D-c. ★최종★ parity 게이트 인라인 — 0행이어야 GO
SELECT v.settlement_code, v.wallet_remain, v.legacy_remain, v.wallet_remain - v.legacy_remain AS diff
  FROM (
    SELECT w.owner_id AS settlement_code,
           (w.credit_limit + w.deposit_balance - w.credit_used_amount - w.credit_excess_amount) AS wallet_remain,
           (MAX(uc.maximum_limit)
             + (CASE WHEN MAX(uc.balance_management_type)='COMPANY'
                     THEN MAX(uc.balance) ELSE COALESCE(SUM(u.balance),0) END)
             - COALESCE(SUM(u.all_settle_amount),0)) AS legacy_remain
      FROM wallet_account w
      JOIN `user` u ON u.settlement_code=w.owner_id AND u.deleted_at IS NULL
      JOIN user_company uc ON uc.id=u.company_id
     WHERE w.owner_type='SETTLEMENT_CODE'
     GROUP BY w.owner_id, w.credit_limit, w.deposit_balance, w.credit_used_amount, w.credit_excess_amount
  ) v
 WHERE v.wallet_remain <> v.legacy_remain
 ORDER BY ABS(v.wallet_remain - v.legacy_remain) DESC;
-- expect: 0 rows → GO


-- =============================================================================
-- D-a(5행) + D-b(전 PASS) + D-c(0행) → COMMIT;   /   이상 → ROLLBACK;
-- 이후: ops_20260707_pr3_parity_gate.sql 독립 재실행 0행 재확인 →
--       WALLET_PR3_SETTLE_MODE=wallet → pm2 restart → flip 후 parity 0행 재확인 → 스모크 → freeze 해제.
-- =============================================================================
-- COMMIT;
-- ROLLBACK;
