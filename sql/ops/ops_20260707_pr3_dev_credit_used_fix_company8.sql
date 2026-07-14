-- =============================================================================
-- [DEV] PR3 credit_used 재보정 — company-8 (직전 reconcile 의 +active_alloc 과다설정 정정)
-- 일자: 2026-07-07
-- 환경: DEV 전용. write FREEZE 하 실행.
-- 배경:
--   ops_20260707_pr3_dev_credit_used_reconcile.sql 에서 company-8 타깃을
--   legacy_all_settle + 미해제alloc = 5,490 으로 잡았으나, 이는 잘못된 불변식이었다.
--   코드 근거 — order.service.ts:4199 는 wallet 확정 시 all_settle 에도 credit 을 미러:
--     oneUser.allSettleAmount += finalAllocation.creditUsedAmount + creditExcessAmount;
--   legacy-wallet-credit-sync.service.ts:30 불변식:
--     wallet.credit_used == Σ user.all_settle_amount   (allocation 은 이미 all_settle 에 포함, 더하지 않음)
--   따라서 올바른 타깃 = Σ all_settle_amount(=1,640). alloc 5,350 을 더한 게 이중계산이었다.
-- 정정: company-8 credit_used  6,990 → 1,640 (= Σ all_settle, delta -5,350).
-- 정합 불변식(원복): Σ(credit_used + credit_excess) == Σ all_settle  (전역 6,641 == 6,641)
-- 멱등: 신규 키 ':fix' 사용(기존 ':company-8:credit_used' 와 별개).
-- ★ 실행법: auto-commit OFF + stop-on-error ON. B → START TX → INSERT → D-a(1행) → UPDATE → D-b/D-c → COMMIT.
-- =============================================================================


-- SECTION B. 사전검증 (freeze 하 안정값 — 다르면 freeze 위반/추가활동 → 중단)
SELECT 'B1' AS chk, w.owner_id, w.id AS wallet_account_id,
       w.credit_used_amount, w.credit_excess_amount,
       (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`
         WHERE settlement_code='company-8' AND deleted_at IS NULL) AS all_settle
  FROM wallet_account w
 WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-8';
-- expect: credit_used_amount=6990, credit_excess_amount=0, all_settle=1640


-- START TRANSACTION;   -- ← auto-commit OFF 면 여기서 시작


-- SECTION C-INSERT. 원장 1건 (UPDATE 전, 원본 credit_used 로 amount=1640-6990=-5350 산출)
INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
SELECT w.id, NULL, NULL, 'BALANCE_MODIFY', 'CREDIT', 1640 - w.credit_used_amount, 1640,
       'PR3 DEV credit_used FIX: ->all_settle(1640) (prev +active_alloc overset -5350 correction)',
       'reconcile:pr3:dev:20260707:company-8:credit_used:fix', NOW(6)
  FROM wallet_account w WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-8';

-- D-a. 원장 1건 확인 (1행 아니면 ROLLBACK 후 중단)
SELECT 'D-a' AS chk, idempotency_key, type, resource_type, amount, balance_after
  FROM wallet_transaction
 WHERE idempotency_key = 'reconcile:pr3:dev:20260707:company-8:credit_used:fix';
-- expect 1행: amount=-5350, balance_after=1640


-- SECTION C-UPDATE. (D-a 1행 확인 후)
UPDATE wallet_account SET credit_used_amount = 1640
 WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-8';


-- SECTION D. 사후검증 (COMMIT 전)
-- D-b. company-8: credit_used(+excess) == all_settle
SELECT 'D-b' AS chk, w.owner_id, w.credit_used_amount, w.credit_excess_amount,
       (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`
         WHERE settlement_code='company-8' AND deleted_at IS NULL) AS all_settle,
       (w.credit_used_amount + w.credit_excess_amount)
         - (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`
             WHERE settlement_code='company-8' AND deleted_at IS NULL) AS drift
  FROM wallet_account w
 WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-8';
-- expect: credit_used=1640, drift=0

-- D-c. 전역 불변식 Σ(credit_used+credit_excess) == Σ all_settle
SELECT 'D-c' AS chk,
  (SELECT COALESCE(SUM(credit_used_amount),0) FROM wallet_account)
    + (SELECT COALESCE(SUM(credit_excess_amount),0) FROM wallet_account) AS wallet_credit_total,
  (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`) AS legacy_all_settle_total,
  ((SELECT COALESCE(SUM(credit_used_amount),0) FROM wallet_account)
    + (SELECT COALESCE(SUM(credit_excess_amount),0) FROM wallet_account))
    - (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`) AS drift;
-- expect: drift=0 (6641 == 6641)


-- D-a 1행 + D-b drift=0 + D-c drift=0 → COMMIT;  /  이상 → ROLLBACK;
-- COMMIT;
-- ROLLBACK;
