-- =============================================================================
-- [DEV] PR3 Read SoT Cutover 선행 — wallet.deposit_balance → company.balance 정정 (2계정)
-- 일자: 2026-07-07
-- 환경: DEV 전용. prod 는 flip 직전 자체 진단 + 직원확인값으로 별도 작성.
-- 성격: 데이터 변경(2행 UPDATE + audit 2행). write FREEZE 하 실행. 검증 통과 시에만 COMMIT.
-- 목적:
--   COMPANY 모드는 legacy 잔여한도 조회가 effectiveBalance = company.balance 만 사용
--   (settle.service.ts:2115,2792). user.balance 는 phantom(미반영). 그러나 backfill 은
--   wallet.deposit = company.balance + Σuser.balance 로 seed → wallet 이 phantom 을 머금어 과대.
--   PR3=wallet 전환 시 wallet.deposit_balance 가 SoT(settle.service.ts:2850)라 이 과대분이
--   그대로 잔여한도 과대 표기로 노출된다. flip 투명 = wallet.deposit == company.balance.
--
-- 진단 (2026-07-07, read-correct 기준 = COMPANY?company.balance:Σuser.balance):
--   company-4  deposit 270,000 → 0        (company.balance=0, phantom user.balance 270,000)
--   company-8  deposit 104,442 → 53,511   (company.balance=53,511, phantom user.balance 50,891)
--
-- 정합 불변식 (flip readiness, COMPANY 모드 교정판):
--   wallet.deposit_balance == company.balance   (naive P1-b `company.balance + Σuser.balance` 는
--   COMPANY 모드 phantom 때문에 틀림 — credit_used 게이트와 동일 성격)
--
-- ⚠️ company-4 (−270,000): company.balance=0 이 실측이면 진행. company-4 가 실제 예치금
--    보유해야 한다면 company.balance(legacy SoT) 정정이 선행 — 그건 legacy 데이터 이슈(지금
--    legacy 조회도 0 으로 서빙 중). dev 는 legacy 매칭이 정답.
--
-- phantom user.balance(§E, 선택): 읽기 투명성에는 불필요(legacy·wallet 조회 모두 미사용).
--   naive P1-a/P1-b 게이트까지 수렴시키려면 COMPANY 모드 user.balance 를 0 으로 정리(하단 §E).
--
-- ⚠️ 실행 전제: (1) 금액 write FREEZE (2) DB 백업 (3) SECTION B expect 충족 (4) 검증 통과 시만 COMMIT.
-- 멱등: wallet_transaction.idempotency_key UNIQUE → 재실행 시 Duplicate 로 차단.
-- ★ 실행법: auto-commit OFF + stop-on-error ON. 동일 커넥션에서 순서대로
--    B → START TRANSACTION → C-INSERT(원장 2건) → D-a(2행 확인) → C-UPDATE(2건) → D-b/D-c → COMMIT.
-- =============================================================================


-- =============================================================================
-- SECTION B. 사전검증 — wallet_deposit / company.balance (expect 일치 필수)
-- =============================================================================
SELECT 'B1' AS chk, w.owner_id AS settlement_code, w.id AS wallet_account_id,
       w.deposit_balance AS wallet_deposit,
       MAX(c.balance) AS company_balance,
       MAX(c.balance_management_type) AS mode
  FROM wallet_account w
  JOIN `user` u ON u.settlement_code = w.owner_id AND u.deleted_at IS NULL
  JOIN user_company c ON c.id = u.company_id
 WHERE w.owner_type = 'SETTLEMENT_CODE'
   AND w.owner_id IN ('company-4','company-8')
 GROUP BY w.owner_id, w.id, w.deposit_balance
 ORDER BY w.owner_id;
-- expect: company-4 wallet_deposit=270000 company_balance=0 COMPANY
--         company-8 wallet_deposit=104442 company_balance=53511 COMPANY


-- =============================================================================
-- START TRANSACTION;   -- ← auto-commit OFF 라면 명시적으로 여기서 시작
-- =============================================================================


-- =============================================================================
-- SECTION C-INSERT. 원장 2건 (UPDATE 보다 먼저 — 원본 deposit 으로 amount 산출)
-- =============================================================================
INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
SELECT w.id, NULL, NULL, 'BALANCE_MODIFY', 'DEPOSIT', 0 - w.deposit_balance, 0,
       'PR3 DEV reconcile: deposit->company.balance(0) (COMPANY phantom user.balance overseed fix)',
       'reconcile:pr3:dev:20260707:company-4:deposit', NOW(6)
  FROM wallet_account w WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-4';

INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
SELECT w.id, NULL, NULL, 'BALANCE_MODIFY', 'DEPOSIT', 53511 - w.deposit_balance, 53511,
       'PR3 DEV reconcile: deposit->company.balance(53511) (COMPANY phantom user.balance overseed fix)',
       'reconcile:pr3:dev:20260707:company-8:deposit', NOW(6)
  FROM wallet_account w WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-8';

-- ★★ D-a. 원장 2건 들어갔는지 확인 (2행 아니면 INSERT 누락 → ROLLBACK 후 중단) ★★
SELECT 'D-a' AS chk, wt.idempotency_key, wt.type, wt.resource_type, wt.amount, wt.balance_after
  FROM wallet_transaction wt
 WHERE wt.idempotency_key LIKE 'reconcile:pr3:dev:20260707:%:deposit'
 ORDER BY wt.idempotency_key;
-- expect 2행: company-4 -270000/0, company-8 -50931/53511


-- =============================================================================
-- SECTION C-UPDATE. 잔액 2건 (D-a 2행 확인 후에만 실행)
-- =============================================================================
UPDATE wallet_account SET deposit_balance = 0     WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-4';
UPDATE wallet_account SET deposit_balance = 53511 WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-8';


-- =============================================================================
-- SECTION D. 사후검증 (COMMIT 전, 트랜잭션 내)
-- =============================================================================

-- D-b. 대상 2계정: wallet.deposit == company.balance (COMPANY 모드 교정 불변식)
SELECT 'D-b' AS chk, w.owner_id AS settlement_code, w.deposit_balance AS wallet_deposit,
       MAX(c.balance) AS company_balance,
       w.deposit_balance - MAX(c.balance) AS drift,
       IF(w.deposit_balance = MAX(c.balance), 'PASS', 'FAIL') AS verdict
  FROM wallet_account w
  JOIN `user` u ON u.settlement_code = w.owner_id AND u.deleted_at IS NULL
  JOIN user_company c ON c.id = u.company_id
 WHERE w.owner_type='SETTLEMENT_CODE'
   AND w.owner_id IN ('company-4','company-8')
 GROUP BY w.owner_id, w.deposit_balance
 ORDER BY w.owner_id;
-- expect: 2행 verdict=PASS (drift=0)

-- D-c. read-correct 전수 재검 — 남은 deposit drift 0 이어야 함
SELECT 'D-c' AS chk, COUNT(*) AS remaining_deposit_drift
  FROM (
    SELECT w.owner_id
      FROM wallet_account w
      JOIN `user` u ON u.settlement_code = w.owner_id AND u.deleted_at IS NULL
      JOIN user_company c ON c.id = u.company_id
     WHERE w.owner_type='SETTLEMENT_CODE'
     GROUP BY w.owner_id, w.deposit_balance
    HAVING w.deposit_balance <> (CASE WHEN MAX(c.balance_management_type)='COMPANY'
                                      THEN MAX(c.balance) ELSE COALESCE(SUM(u.balance),0) END)
  ) v;
-- expect: remaining_deposit_drift=0


-- =============================================================================
-- D-a 2행 + D-b 2행 PASS + D-c 0 → COMMIT;   /   이상 → ROLLBACK;
-- =============================================================================
-- COMMIT;
-- ROLLBACK;


-- =============================================================================
-- SECTION E. [선택/별도] COMPANY 모드 phantom user.balance 정리 (flip 블로커 아님)
--   naive P1-a/P1-b 게이트까지 0 으로 수렴시키려면 freeze 중 별도 검토 후 실행.
--   읽기 투명성에는 불필요(legacy·wallet 조회 모두 COMPANY 모드에서 user.balance 미사용).
-- =============================================================================
-- -- 사전확인: COMPANY 모드인데 user.balance <> 0 (phantom)
-- SELECT u.id, u.email, u.company_id, u.balance
-- FROM `user` u JOIN user_company c ON c.id=u.company_id
-- WHERE c.balance_management_type='COMPANY' AND u.balance <> 0 AND u.deleted_at IS NULL;
-- -- 실행(검토 후): UPDATE `user` u JOIN user_company c ON c.id=u.company_id SET u.balance=0
-- --   WHERE c.balance_management_type='COMPANY' AND u.balance<>0 AND u.deleted_at IS NULL;
-- =============================================================================
