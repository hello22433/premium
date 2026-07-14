-- =============================================================================
-- [DEV] PR3 Read SoT Cutover 선행 — wallet.credit_used backfill 과대 seed 정정 (4계정)
-- 일자: 2026-07-07
-- 환경: DEV 전용 (prod 아님). prod 는 flip 직전 자체 진단값으로 별도 작성.
-- 성격: 데이터 변경(4행 UPDATE + audit 4행). write FREEZE 하 실행. 검증 통과 시에만 COMMIT.
-- 목적:
--   PR3(WALLET_PR3_SETTLE_MODE=wallet) 전환 시 잔여한도 조회 SoT 가 wallet 로 바뀐다.
--   wallet.credit_used_amount 가 backfill 스냅샷 고수위에 stale 하게 멈춰 legacy 실측보다
--   과대(+2,012,196). 이대로 flip 하면 잔여한도가 실제보다 대폭 낮게 표기된다.
--
-- 보정 타깃 (절대값 = legacy_all_settle + 미해제 alloc net credit):
--   company-8 credit_used  1,688,686 → 5,490   (= legacy 140 + alloc 5,350: order 803=4750,822=600)
--   company-4 credit_used    300,000 → 0       (= legacy 0   + alloc 0)
--   company-7 credit_used     19,000 → 0       (= legacy 0   + alloc 0)
--   company-1 credit_used     15,001 → 5,001   (= legacy 5,001 + alloc 0)
--
-- 정합 불변식 (flip readiness, mixed-mode 교정판):
--   wallet.credit_used == legacy.all_settle + Σ(미해제 alloc net credit)  → 전역 10,491 = 5,141 + 5,350
--   (naive Σall_settle==Σcredit_used 게이트는 미해제 alloc 만큼 diff 가 남는 게 정상)
-- underflow 안전: 타깃 >= 미해제 alloc net credit (803/822 release 시 5,490→140).
--
-- ⚠️ 실행 전제: (1) 금액 write FREEZE (2) DB 백업 (3) SECTION B expect 충족 (4) 검증 통과 시만 COMMIT.
-- 멱등: wallet_transaction.idempotency_key UNIQUE → 재실행 시 Duplicate 로 차단.
--
-- ★ 실행법 (중요 — 클라이언트가 스크립트 내 INSERT...SELECT 를 건너뛰는 사고 방지):
--   1) auto-commit OFF, stop-on-error ON 설정.
--   2) 동일 커넥션에서 순서대로:
--        SECTION B (precheck)  →  expect 일치 확인
--        START TRANSACTION;
--        SECTION C-INSERT (원장 4건)  →  ★ D-a 실행해 4행인지 확인 (4행 아니면 ROLLBACK 후 중단)
--        SECTION C-UPDATE (잔액 4건)  →  D-b(4행 PASS) + D-c(drift=0) 확인
--        전부 정상이면 COMMIT; 아니면 ROLLBACK;
--   INSERT 를 UPDATE 보다 먼저 전부 넣고 D-a 로 검증하므로 UPDATE-without-audit 상태가 원천 차단됨.
--   INSERT 는 UPDATE 전 원본 credit_used 를 읽어 amount(=타깃−현재)를 산출.
-- =============================================================================


-- =============================================================================
-- SECTION B. 사전검증 — current / legacy / 미해제 alloc (expect 일치 필수)
-- =============================================================================
SELECT 'B1' AS chk, w.owner_id AS settlement_code, w.id AS wallet_account_id,
       w.credit_used_amount AS wallet_credit_used,
       COALESCE(u.all_settle, 0) AS legacy_all_settle,
       COALESCE(a.active_alloc, 0) AS active_alloc,
       COALESCE(u.all_settle, 0) + COALESCE(a.active_alloc, 0) AS target_expected
  FROM wallet_account w
  LEFT JOIN (SELECT settlement_code, SUM(all_settle_amount) AS all_settle
               FROM `user` WHERE deleted_at IS NULL GROUP BY settlement_code) u
         ON u.settlement_code = w.owner_id
  LEFT JOIN (SELECT wallet_account_id, SUM(credit_used_amount - credit_used_restored_amount) AS active_alloc
               FROM order_payment_allocation WHERE released_at IS NULL GROUP BY wallet_account_id) a
         ON a.wallet_account_id = w.id
 WHERE w.owner_type = 'SETTLEMENT_CODE'
   AND w.owner_id IN ('company-8','company-4','company-7','company-1')
 ORDER BY w.owner_id;
-- expect: c1 15001/5001/0/5001, c4 300000/0/0/0, c7 19000/0/0/0, c8 1688686/140/5350/5490


-- =============================================================================
-- START TRANSACTION;   -- ← auto-commit OFF 라면 명시적으로 여기서 시작
-- =============================================================================


-- =============================================================================
-- SECTION C-INSERT. 원장 4건 (UPDATE 보다 먼저 — 원본 credit_used 로 amount 산출)
-- =============================================================================
INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
SELECT w.id, NULL, NULL, 'BALANCE_MODIFY', 'CREDIT', 5490 - w.credit_used_amount, 5490,
       'PR3 DEV reconcile: credit_used->legacy(140)+active_alloc(5350) (backfill overseed fix)',
       'reconcile:pr3:dev:20260707:company-8:credit_used', NOW(6)
  FROM wallet_account w WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-8';

INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
SELECT w.id, NULL, NULL, 'BALANCE_MODIFY', 'CREDIT', 0 - w.credit_used_amount, 0,
       'PR3 DEV reconcile: credit_used->legacy(0) (backfill overseed full fix)',
       'reconcile:pr3:dev:20260707:company-4:credit_used', NOW(6)
  FROM wallet_account w WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-4';

INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
SELECT w.id, NULL, NULL, 'BALANCE_MODIFY', 'CREDIT', 0 - w.credit_used_amount, 0,
       'PR3 DEV reconcile: credit_used->legacy(0) (backfill overseed full fix)',
       'reconcile:pr3:dev:20260707:company-7:credit_used', NOW(6)
  FROM wallet_account w WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-7';

INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
SELECT w.id, NULL, NULL, 'BALANCE_MODIFY', 'CREDIT', 5001 - w.credit_used_amount, 5001,
       'PR3 DEV reconcile: credit_used->legacy(5001) (backfill overseed fix)',
       'reconcile:pr3:dev:20260707:company-1:credit_used', NOW(6)
  FROM wallet_account w WHERE w.owner_type='SETTLEMENT_CODE' AND w.owner_id='company-1';

-- ★★ D-a. 원장 4건 들어갔는지 확인 (4행 아니면 INSERT 누락 → ROLLBACK 후 중단) ★★
SELECT 'D-a' AS chk, wt.idempotency_key, wt.type, wt.resource_type, wt.amount, wt.balance_after
  FROM wallet_transaction wt
 WHERE wt.idempotency_key LIKE 'reconcile:pr3:dev:20260707:%'
 ORDER BY wt.idempotency_key;
-- expect 4행: c1 -10000/5001, c4 -300000/0, c7 -19000/0, c8 -1683196/5490


-- =============================================================================
-- SECTION C-UPDATE. 잔액 4건 (D-a 4행 확인 후에만 실행)
-- =============================================================================
UPDATE wallet_account SET credit_used_amount = 5490 WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-8';
UPDATE wallet_account SET credit_used_amount = 0    WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-4';
UPDATE wallet_account SET credit_used_amount = 0    WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-7';
UPDATE wallet_account SET credit_used_amount = 5001 WHERE owner_type='SETTLEMENT_CODE' AND owner_id='company-1';


-- =============================================================================
-- SECTION D. 사후검증 (COMMIT 전, 트랜잭션 내)
-- =============================================================================

-- D-b. 대상 4계정: credit_used == legacy_all_settle + 미해제 alloc (per account)
SELECT 'D-b' AS chk, w.owner_id AS settlement_code, w.credit_used_amount AS wallet_credit_used,
       COALESCE(u.all_settle,0) + COALESCE(a.active_alloc,0) AS target,
       w.credit_used_amount - (COALESCE(u.all_settle,0) + COALESCE(a.active_alloc,0)) AS drift,
       IF(w.credit_used_amount = COALESCE(u.all_settle,0) + COALESCE(a.active_alloc,0), 'PASS', 'FAIL') AS verdict
  FROM wallet_account w
  LEFT JOIN (SELECT settlement_code, SUM(all_settle_amount) AS all_settle
               FROM `user` WHERE deleted_at IS NULL GROUP BY settlement_code) u
         ON u.settlement_code = w.owner_id
  LEFT JOIN (SELECT wallet_account_id, SUM(credit_used_amount - credit_used_restored_amount) AS active_alloc
               FROM order_payment_allocation WHERE released_at IS NULL GROUP BY wallet_account_id) a
         ON a.wallet_account_id = w.id
 WHERE w.owner_type='SETTLEMENT_CODE'
   AND w.owner_id IN ('company-8','company-4','company-7','company-1')
 ORDER BY w.owner_id;
-- expect: 4행 전부 verdict=PASS (drift=0)

-- D-c. 전역 정합: Σcredit_used == Σall_settle + Σ미해제alloc
SELECT 'D-c' AS chk,
  (SELECT COALESCE(SUM(credit_used_amount),0) FROM wallet_account) AS wallet_credit_used_total,
  (SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`) AS legacy_all_settle_total,
  (SELECT COALESCE(SUM(credit_used_amount - credit_used_restored_amount),0)
     FROM order_payment_allocation WHERE released_at IS NULL) AS active_alloc_total,
  (SELECT COALESCE(SUM(credit_used_amount),0) FROM wallet_account)
    - ((SELECT COALESCE(SUM(all_settle_amount),0) FROM `user`)
       + (SELECT COALESCE(SUM(credit_used_amount - credit_used_restored_amount),0)
            FROM order_payment_allocation WHERE released_at IS NULL)) AS drift;
-- expect: drift=0  (wallet 10491 == legacy 5141 + active_alloc 5350)


-- =============================================================================
-- D-a 4행 + D-b 4행 PASS + D-c drift=0 → COMMIT;   /   하나라도 이상 → ROLLBACK;
-- 이후 deposit +40(company-8) 별도 정리 → cutover_gate 재판정 → PR3=wallet flip → pm2 restart → 스모크.
-- =============================================================================
-- COMMIT;
-- ROLLBACK;
