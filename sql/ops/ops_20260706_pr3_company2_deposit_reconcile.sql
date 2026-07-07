-- =============================================================================
-- PR3 전환 선행 — company-2 wallet deposit_balance 정적 갭 보정 (+100,000)
-- 일자: 2026-07-06
-- 근거:
--   shadow 로그(2026-07-06) 판독 — company-2(공유 settlement_code, userId 7·10·16·17·18·19·
--   23·24·96) 의 wallet_shadow_mismatch_remain 이 하루 종일 delta=-100000 로 균일 고정.
--   진단 쿼리(userId=19): d_deposit_company=-100000 (wallet.deposit_balance=181,100 <
--   user_company.balance=281,100). d_limit=0, d_used=0. → 예치금 단일 축 100,000 부족.
--   잔액이 종일 변해도 offset 불변 → 진행성 미러 버그 아님(발송/환불 경로는 wallet·legacy 동시
--   갱신 확인). 06-30 reconcile 이후 유입된 1회성 정적 갭으로 판정. company.balance 를 예치금
--   SoT(운영자 은행관리) 로 두는 06-30 원칙에 따라 wallet 을 company.balance 로 끌어올린다.
-- 성격: 데이터 변경(1행 UPDATE + audit 1행). 반드시 아래 전제하에 실행.
-- ⚠️ 실행 전제:
--   1) 전체 금액 write FREEZE (충전/주문/정산/CS/재발송/외부API/관련 cron 중단).
--   2) DB 백업 완료.
--   3) SECTION B 가드에서 delta 가 예상(+100000)과 일치할 때만 COMMIT. 아니면 ROLLBACK.
-- 멱등: wallet_transaction.idempotency_key UNIQUE → 재실행 시 Duplicate 로 두 번째 실행 차단.
-- =============================================================================

SET @owner  = 'company-2';
SET @actor  = 'ops: PR3 company-2 deposit reconcile 2026-07-06';
SET @expect_delta = 100000;   -- 진단 기준 예상 보정액(부족분). 가드용.

START TRANSACTION;

-- ---- B. lock + 현재값/타깃(SoT) 확보 ----
SELECT w.id, w.deposit_balance
  INTO @wa, @cur
  FROM wallet_account w
 WHERE w.owner_type = 'SETTLEMENT_CODE' AND w.owner_id = @owner
 FOR UPDATE;

-- company-2 = user_company.id 2 (owner_id 'company-<id>'). COMPANY 모드 예치금 SoT = company.balance.
SELECT uc.balance
  INTO @target
  FROM user_company uc
 WHERE uc.id = CAST(SUBSTRING_INDEX(@owner, '-', -1) AS UNSIGNED)
 FOR UPDATE;

SET @delta = @target - @cur;

-- 가드 표시: wallet_id / 현재 wallet 예치금 / company.balance(SoT) / 보정 delta.
--   기대: delta = @expect_delta(=100000). 다르면 freeze 위반 또는 원인 재검 필요 → ROLLBACK.
SELECT 'B-guard' AS chk, @wa AS wallet_id, @cur AS wallet_deposit,
       @target AS company_balance, @delta AS delta,
       IF(@delta = @expect_delta, 'OK-PROCEED', 'ABORT-ROLLBACK') AS verdict;

-- ---- C. 보정 (가드 verdict='OK-PROCEED' 확인 후에만 아래 실행) ----
UPDATE wallet_account SET deposit_balance = @target WHERE id = @wa;

INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
VALUES
  (@wa, NULL, NULL, 'BALANCE_MODIFY', 'DEPOSIT', @delta, @target,
   'PR3 reconcile: company-2 deposit→company.balance (static mirror gap 100k)',
   'reconcile:pr3:20260706:company-2:deposit', NOW(6));

-- ---- D. 사후검증 (COMMIT 전) ----
-- D1. wallet 예치금 == company.balance
SELECT 'D1' AS chk, w.deposit_balance AS wallet_deposit, uc.balance AS company_balance,
       w.deposit_balance - uc.balance AS drift
  FROM wallet_account w
  JOIN user_company uc ON uc.id = CAST(SUBSTRING_INDEX(w.owner_id, '-', -1) AS UNSIGNED)
 WHERE w.id = @wa;
-- expect: drift = 0

-- D2. audit row 확인
SELECT 'D2' AS chk, wt.idempotency_key, wt.type, wt.resource_type, wt.amount, wt.balance_after
  FROM wallet_transaction wt
 WHERE wt.idempotency_key = 'reconcile:pr3:20260706:company-2:deposit';
-- expect 1행: DEPOSIT / BALANCE_MODIFY / amount=+100000 / balance_after=company.balance

-- =============================================================================
-- 검증 정상(D1 drift=0) → COMMIT;   /   가드 ABORT 또는 이상 → ROLLBACK;
-- 이후 ops_20260706_pr3_cutover_gate.sql 재실행 → 전 게이트 PASS 확인 → PR3=wallet 플립.
-- =============================================================================
-- COMMIT;
-- ROLLBACK;
