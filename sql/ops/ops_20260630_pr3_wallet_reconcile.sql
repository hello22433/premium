-- =============================================================================
-- PR3 Read SoT Cutover 선행 — wallet ↔ legacy drift 재조정 (5계정)
-- 일자: 2026-06-30
-- 목적:
--   PR3(WALLET_PR3_SETTLE_MODE=wallet) 전환 시 잔여한도 조회 SoT 가 wallet 로 바뀐다.
--   전환을 투명하게(고객 표시값 불변) 하려면 wallet 값이 "현재 PR3=legacy 에서 고객이
--   보는 값"과 일치해야 한다. 진단(2026-06-30)에서 발견된 wallet≠legacy 4계정 + credit_limit
--   1계정을 legacy(운영자 유지 SoT)에 맞춰 보정한다.
--
-- 진단 근거 (요약):
--   - 모든 대상 회사 balance_management_type=COMPANY → 실효 예치금 = user_company.balance.
--     (COMPANY 모드는 user.balance 미사용. 잔여 user-level 잔액은 phantom → §E 별도 정리)
--   - deposit: legacy company.balance 가 운영자 수동관리 SoT (activity_log BALANCE_CHARGE/MODIFY
--     로 은행 입금기준 유지). wallet 은 미러 누락으로 drift.
--   - company-15 credit_used: wallet 429,300 은 백필 과대 seed(미해제). 실 미해제 allocation=41,700,
--     legacy all_settle=137,700(주문 정합) → legacy 채택.
--   - company-4 credit_limit: 200 vs maximum_limit 5,000 (한도 변경 미동기 잔재).
--
-- 보정 타깃 (절대값, 운영자/직원 확인 완료):
--   company-2  deposit_balance     500       → 151,100   (= company.balance)
--   company-13 deposit_balance     859,776   → 787,676   (= company.balance, 다솜프라자 직원확인)
--   company-40 deposit_balance     1,950,400 → 2,472,900 (= company.balance, 위버스마인드; 오늘 89.445M 발송완료 후 실잔액)
--   company-15 credit_used_amount  429,300   → 137,700   (= legacy all_settle)
--   company-4  credit_limit        200       → 5,000     (= maximum_limit)
--
-- ⚠️ 실행 전제:
--   1) 전체 금액 write FREEZE (충전/주문/정산/CS/재발송/외부API/관련 cron 중단) 상태에서 실행.
--   2) DB 백업 완료.
--   3) SECTION B 의 current 값이 위 "현재값"과 일치하는지 확인(불일치=freeze 중 변동 → 중단).
--   4) SECTION D 검증 통과 시에만 COMMIT, 아니면 ROLLBACK.
--
-- 멱등: wallet_transaction.idempotency_key UNIQUE → 재실행 시 Duplicate 로 자동 차단(ROLLBACK).
--       (deposit/credit UPDATE 는 절대값이라 재실행 무해하나, INSERT dup 으로 두 번째 실행은 막힌다)
-- =============================================================================


-- =============================================================================
-- SECTION A. 파라미터 (절대 타깃값)
-- =============================================================================
SET @t_c2_deposit   = 151100;
SET @t_c13_deposit  = 787676;
SET @t_c40_deposit  = 2472900;
SET @t_c15_credit   = 137700;
SET @t_c4_limit     = 5000;
SET @actor          = 'ops: PR3 readiness reconcile 2026-06-30';


-- =============================================================================
-- SECTION B. 사전검증 — current 값이 진단 시점과 동일한지 + drift 재확인
--   (아래 결과의 wallet_* 가 "현재값"과 같아야 함. 다르면 freeze 위반 → 중단)
-- =============================================================================

-- B1. 대상 wallet 현재값 + legacy 대조값
SELECT 'B1' AS chk,
       w.owner_id                              AS settlement_code,
       w.id                                    AS wallet_account_id,
       w.deposit_balance                       AS wallet_deposit,
       w.credit_limit                          AS wallet_credit_limit,
       w.credit_used_amount                    AS wallet_credit_used,
       c.balance                               AS company_balance,
       c.maximum_limit                         AS company_maximum_limit,
       (SELECT COALESCE(SUM(u.all_settle_amount),0)
          FROM `user` u WHERE u.settlement_code = w.owner_id AND u.deleted_at IS NULL) AS legacy_all_settle
  FROM wallet_account w
  JOIN `user` ju ON ju.settlement_code = w.owner_id AND ju.deleted_at IS NULL
  JOIN user_company c ON c.id = ju.company_id
 WHERE w.owner_type = 'SETTLEMENT_CODE'
   AND w.owner_id IN ('company-2','company-13','company-15','company-40','company-4')
 GROUP BY w.owner_id, w.id, w.deposit_balance, w.credit_limit, w.credit_used_amount,
          c.balance, c.maximum_limit;
-- expect:
--   company-2  : wallet_deposit=500,        company_balance=151100
--   company-13 : wallet_deposit=859776,     company_balance=787676
--   company-40 : wallet_deposit=1950400,    company_balance=2472900
--   company-15 : wallet_credit_used=429300, legacy_all_settle=137700
--   company-4  : wallet_credit_limit=200,   company_maximum_limit=5000


-- =============================================================================
-- SECTION C. 실행 (B 의 expect 전부 충족 확인 후)
-- =============================================================================
START TRANSACTION;

-- ---- C1. company-2 deposit_balance → 151,100 ----
SELECT id, deposit_balance INTO @wa, @cur
  FROM wallet_account WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-2';
UPDATE wallet_account SET deposit_balance = @t_c2_deposit WHERE id = @wa;
INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
VALUES
  (@wa, NULL, NULL, 'BALANCE_MODIFY', 'DEPOSIT', @t_c2_deposit - @cur, @t_c2_deposit,
   'PR3 reconcile: deposit→company.balance (drift fix)', 'reconcile:pr3:20260630:company-2:deposit', NOW(6));

-- ---- C2. company-13 deposit_balance → 787,676 ----
SELECT id, deposit_balance INTO @wa, @cur
  FROM wallet_account WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-13';
UPDATE wallet_account SET deposit_balance = @t_c13_deposit WHERE id = @wa;
INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
VALUES
  (@wa, NULL, NULL, 'BALANCE_MODIFY', 'DEPOSIT', @t_c13_deposit - @cur, @t_c13_deposit,
   'PR3 reconcile: deposit→company.balance (drift fix, 다솜프라자)', 'reconcile:pr3:20260630:company-13:deposit', NOW(6));

-- ---- C3. company-40 deposit_balance → 2,472,900 ----
SELECT id, deposit_balance INTO @wa, @cur
  FROM wallet_account WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-40';
UPDATE wallet_account SET deposit_balance = @t_c40_deposit WHERE id = @wa;
INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
VALUES
  (@wa, NULL, NULL, 'BALANCE_MODIFY', 'DEPOSIT', @t_c40_deposit - @cur, @t_c40_deposit,
   'PR3 reconcile: deposit→company.balance (drift fix, 위버스마인드)', 'reconcile:pr3:20260630:company-40:deposit', NOW(6));

-- ---- C4. company-15 credit_used_amount → 137,700 ----
SELECT id, credit_used_amount INTO @wa, @cur
  FROM wallet_account WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-15';
UPDATE wallet_account SET credit_used_amount = @t_c15_credit WHERE id = @wa;
INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
VALUES
  (@wa, NULL, NULL, 'BALANCE_MODIFY', 'CREDIT', @t_c15_credit - @cur, @t_c15_credit,
   'PR3 reconcile: credit_used→legacy all_settle (백필 과대 seed 정정)', 'reconcile:pr3:20260630:company-15:credit_used', NOW(6));

-- ---- C5. company-4 credit_limit → 5,000 (한도는 ledger resource 아님 → tx 없음) ----
UPDATE wallet_account SET credit_limit = @t_c4_limit
 WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-4';


-- =============================================================================
-- SECTION D. 사후검증 (COMMIT 전, 트랜잭션 내)
-- =============================================================================

-- D1. wallet 값이 타깃과 일치하는지
SELECT 'D1' AS chk, w.owner_id AS settlement_code,
       w.deposit_balance, w.credit_used_amount, w.credit_limit
  FROM wallet_account w
 WHERE w.owner_type='SETTLEMENT_CODE'
   AND w.owner_id IN ('company-2','company-13','company-15','company-40','company-4')
 ORDER BY w.owner_id;
-- expect: c2 deposit=151100 / c13 deposit=787676 / c40 deposit=2472900
--         c15 credit_used=137700 / c4 credit_limit=5000

-- D2. audit wallet_transaction 4건 기록 확인
SELECT 'D2' AS chk, wt.idempotency_key, wt.type, wt.resource_type, wt.amount, wt.balance_after
  FROM wallet_transaction wt
 WHERE wt.idempotency_key LIKE 'reconcile:pr3:20260630:%'
 ORDER BY wt.idempotency_key;
-- expect 4행: c2 deposit +150600/151100, c13 deposit -72100/787676,
--             c40 deposit +522500/2472900, c15 credit -291600/137700

-- D3. PR3 readiness 재검 — deposit: wallet == company.balance (COMPANY 모드 실효값)
SELECT 'D3-deposit' AS chk, w.owner_id, w.deposit_balance AS wallet_deposit, c.balance AS company_balance,
       w.deposit_balance - c.balance AS drift
  FROM wallet_account w
  JOIN `user` ju ON ju.settlement_code = w.owner_id AND ju.deleted_at IS NULL
  JOIN user_company c ON c.id = ju.company_id
 WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id IN ('company-2','company-13','company-40')
 GROUP BY w.owner_id, w.deposit_balance, c.balance;
-- expect: drift=0 (3건)

-- D4. credit_used / credit_limit 전역 총액 재대조 (legacy vs wallet)
SELECT 'D4' AS chk,
  (SELECT COALESCE(SUM(maximum_limit),0) FROM user_company)      AS legacy_credit_limit,
  (SELECT COALESCE(SUM(credit_limit),0) FROM wallet_account)     AS wallet_credit_limit,
  (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`)        AS legacy_credit_used,
  (SELECT COALESCE(SUM(credit_used_amount),0) FROM wallet_account) AS wallet_credit_used;
-- expect: legacy_credit_limit == wallet_credit_limit (company-4 보정 후 일치)
--         legacy_credit_used  == wallet_credit_used  (company-15 보정 후 일치)


-- =============================================================================
-- 검증 정상 → COMMIT;   /   이상 → ROLLBACK;
-- =============================================================================
-- COMMIT;
-- ROLLBACK;


-- =============================================================================
-- SECTION E. [선택/별도] phantom user-level 잔액 정리 (PR3 블로커 아님)
-- =============================================================================
-- COMPANY 모드인데 user.balance 가 남아있는 phantom 잔액(예: 다솜프라자 user32=151,300,
-- 직원확인상 실잔액 787,676 에 미포함=phantom). 이게 있으면 범용 drift 식
-- (company.balance + SUM(user.balance)) 기준 점검에서 계속 잡힌다. PR3 자체는 D3(=company.balance)
-- 기준이라 블로커 아님. 정리하려면 freeze 중 아래를 별도 검토 후 실행:
--
--   -- 사전확인: COMPANY 모드 회사의 0 아닌 user.balance
--   SELECT u.id, u.email, u.company_id, u.balance
--     FROM `user` u JOIN user_company c ON c.id=u.company_id
--    WHERE c.balance_management_type='COMPANY' AND u.balance <> 0 AND u.deleted_at IS NULL;
--   -- 실행(검토 후): UPDATE `user` u JOIN user_company c ON c.id=u.company_id
--   --                   SET u.balance = 0
--   --                 WHERE c.balance_management_type='COMPANY' AND u.balance <> 0 AND u.deleted_at IS NULL;
-- =============================================================================
