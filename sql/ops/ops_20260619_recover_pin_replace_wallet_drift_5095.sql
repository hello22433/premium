-- =============================================================================
-- 수동 복구 — 핀교체 wallet 장부 미승계로 폐기 환불 누락 (order 5095 / delivery 623012)
-- 일자: 2026-06-19
-- 사유:
--   폐기후신규발송(핀교체)으로 만든 신규 delivery 623012 가 wallet 장부(allocation_line/
--   attempt)를 승계받지 못해, 폐기 시 restoreBalanceOnDiscard 의 drift 가드가 환불을 abort.
--   결과: 쿠폰은 폐기(CANCEL) 됐으나 여신(credit_used) 300원 미환불.
--   원본 618656 은 line 715 + attempt 716 정합, 미환불 상태.
--
-- 동작 (RefundPoolService.refund + restoreBalanceOnDiscard 의 미정산/ALL_SETTLE_AMOUNT 경로 재현):
--   0. 패치(carryWalletOwnershipToReissuedDelivery)가 만들었어야 할 상태 보강:
--        allocation_line 715 의 order_delivery_id 618656 → 623012 repoint
--        + 623012 에 INITIAL/DEDUCTED attempt 생성
--   1. order_payment_refund_event (discard_refund, credit_used 300)
--   2. wallet_account.credit_used_amount -= 300
--   3. wallet_transaction (CREDIT, amount=-300, balance_after)
--   4. order_payment_allocation.credit_used_restored_amount += 300
--   5. order_delivery_refund (멱등 게이트) + order_delivery.refunded_at (623012)
--   6. legacy mirror: user.all_settle_amount -= 300 (billing user 18)
--
-- 안전장치:
--   - 전부 START TRANSACTION 안에서 수행. SECTION D 검증 통과 시에만 COMMIT.
--   - 재실행 방지: refund_event.idempotency_key UNIQUE + order_delivery_refund.order_delivery_id
--     UNIQUE → 두 번째 실행은 Duplicate 에러로 자동 차단(ROLLBACK).
--   - 이 SQL 은 "순수 여신(credit) 단일 라인 300원" 케이스 전용.
--     point/deposit/credit_excess/card_surcharge 가 0 이 아니면 SECTION B 에서 발견 → 절대 실행 금지.
--
-- 사용법: SECTION A 파라미터 확인 → SECTION B 사전검증(모든 expect 충족 확인)
--         → SECTION C 실행 → SECTION D 검증 → 정상이면 COMMIT, 아니면 ROLLBACK.
-- =============================================================================


-- =============================================================================
-- SECTION A. 파라미터
-- =============================================================================
SET @order_id         = 5095;
SET @allocation_id    = 12;
SET @line_id          = 715;     -- order_payment_allocation_line.id (현재 order_delivery_id=618656)
SET @old_delivery_id  = 618656;  -- 핀교체 원본 (line/attempt 정합)
SET @new_delivery_id  = 623012;  -- 핀교체 신규 (폐기됨, drift)
SET @billing_user_id  = 18;      -- order.client_user_id ?? order.user_id
SET @actor_user_id    = 18;      -- 감사용 operator (필요 시 실행 관리자 user.id 로 교체)
SET @amount           = 300;     -- 환불 여신액

SELECT '[A] params' AS info, @order_id AS order_id, @allocation_id AS allocation_id,
       @line_id AS line_id, @old_delivery_id AS old_d, @new_delivery_id AS new_d,
       @billing_user_id AS billing_user, @amount AS amount;


-- =============================================================================
-- SECTION B. 사전검증 — 모든 expect 가 충족돼야 실행
-- =============================================================================

-- B1. 신규 delivery drift 확인 (attempt 0건 이어야 함)  → expect: attempt_cnt = 0
SELECT 'B1' AS chk, COUNT(*) AS attempt_cnt, 'expect 0' AS expect
  FROM order_delivery_attempt WHERE order_delivery_id = @new_delivery_id;

-- B2. 두 delivery 모두 폐기(CANCEL) 상태  → expect: 2행 모두 CANCEL
SELECT 'B2' AS chk, id, coupon_status, status, replaced_from_id, refunded_at
  FROM order_delivery WHERE id IN (@old_delivery_id, @new_delivery_id);

-- B3. 대상 라인이 "순수 credit 300, 그 외 0" 인지  → expect: 정확히 1행, 아래 값
SELECT 'B3' AS chk, id, allocation_id, order_delivery_id,
       gross_settlement_amount, payable_base, point_used_amount,
       deposit_used_amount, credit_used_amount, credit_excess_amount
  FROM order_payment_allocation_line
 WHERE id = @line_id AND allocation_id = @allocation_id AND order_delivery_id = @old_delivery_id;
-- expect: gross=300, payable_base=300, point_used=0, deposit_used=0, credit_used=300, credit_excess=0

-- B4. allocation 레벨 풀이 credit 전용인지(point/excess/card할증 없음)  → expect: 모두 0
SELECT 'B4' AS chk, id, point_used_amount, credit_excess_amount, card_surcharge_applied, released_at
  FROM order_payment_allocation WHERE id = @allocation_id;
-- expect: point_used_amount=0, credit_excess_amount=0, card_surcharge_applied=0, released_at IS NULL

-- B5. 이미 환불된 적 없는지(멱등)  → expect: 두 카운트 모두 0
SELECT 'B5' AS chk,
       (SELECT COUNT(*) FROM order_delivery_refund
         WHERE order_delivery_id IN (@old_delivery_id, @new_delivery_id)) AS ledger_cnt,
       (SELECT COUNT(*) FROM order_payment_refund_event
         WHERE allocation_id = @allocation_id AND reversed_at IS NULL
           AND (JSON_CONTAINS(affected_delivery_ids, CAST(@old_delivery_id AS JSON))
             OR JSON_CONTAINS(affected_delivery_ids, CAST(@new_delivery_id AS JSON)))) AS event_overlap_cnt,
       'expect 0/0' AS expect;

-- B6. wallet_account 현재 credit_used (참고)  → 실행 후 -300 검증용
SELECT 'B6' AS chk, wa.id AS wallet_account_id, wa.credit_used_amount AS credit_used_before
  FROM wallet_account wa
  JOIN order_payment_allocation a ON a.wallet_account_id = wa.id
 WHERE a.id = @allocation_id;

-- B7. legacy mirror 현재값 (참고)  → 실행 후 -300 검증용
SELECT 'B7' AS chk, id, all_settle_amount AS all_settle_before
  FROM `user` WHERE id = @billing_user_id;


-- =============================================================================
-- SECTION C. 실행 (B 전부 expect 충족 확인 후)
-- =============================================================================
START TRANSACTION;

SELECT wallet_account_id INTO @wallet_account_id
  FROM order_payment_allocation WHERE id = @allocation_id;

-- C0a. allocation_line repoint (원본 → 신규)
UPDATE order_payment_allocation_line
   SET order_delivery_id = @new_delivery_id
 WHERE id = @line_id AND allocation_id = @allocation_id AND order_delivery_id = @old_delivery_id;
-- (affected_rows = 1 이어야 함)

-- C0b. 신규 delivery 에 INITIAL/DEDUCTED attempt 생성
INSERT INTO order_delivery_attempt (order_delivery_id, attempt_type, status, deducted_at)
VALUES (@new_delivery_id, 'INITIAL', 'DEDUCTED', NOW(6));
SET @attempt_id = LAST_INSERT_ID();

-- 멱등 키: discard_refund:{orderId}:{deliveryId}:{attemptId}:line:{lineId}
SET @idem = CONCAT('discard_refund:', @order_id, ':', @new_delivery_id, ':', @attempt_id, ':line:', @line_id);

-- C1. refund_event ledger (순수 credit 300)
INSERT INTO order_payment_refund_event
  (allocation_id, order_id, event_type, affected_delivery_ids,
   refunded_gross_base, refunded_payable_base, refunded_card_surcharge_amount,
   refunded_point_amount, refunded_deposit_amount, refunded_credit_used_amount,
   refunded_credit_excess_amount, point_skipped_expired_amount,
   idempotency_key, reversed_at, reversed_by_wallet_transaction_id, created_at)
VALUES
  (@allocation_id, @order_id, 'discard_refund', JSON_ARRAY(@new_delivery_id),
   @amount, @amount, 0,
   0, 0, @amount,
   0, 0,
   @idem, NULL, NULL, NOW(6));

-- C2. wallet_account credit_used 복구
UPDATE wallet_account
   SET credit_used_amount = credit_used_amount - @amount
 WHERE id = @wallet_account_id;
SELECT credit_used_amount INTO @new_credit_used FROM wallet_account WHERE id = @wallet_account_id;

-- C3. wallet_transaction (CREDIT, amount 음수 = credit_used 감소, balance_after = 갱신 후 값)
INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
VALUES
  (@wallet_account_id, @order_id, @new_delivery_id, 'DISCARD_REFUND', 'CREDIT',
   -@amount, @new_credit_used, 'manual recovery: pin-replace wallet drift (5095/623012)',
   CONCAT(@idem, ':credit'), NOW(6));

-- C4. allocation 누적 복구 카운터
UPDATE order_payment_allocation
   SET credit_used_restored_amount = credit_used_restored_amount + @amount
 WHERE id = @allocation_id;

-- C5. refund_ledger (멱등 게이트) + order_delivery.refunded_at
INSERT INTO order_delivery_refund
  (order_delivery_id, user_id, refund_amount, restore_type, is_settle_complete, is_settle_balance,
   source_path, operator_user_id, memo, refunded_at, ssg_balance_settled)
VALUES
  (@new_delivery_id, @billing_user_id, @amount, 'ALL_SETTLE_AMOUNT', 0, 0,
   'CS_DISCARD', @actor_user_id, 'manual recovery pin-replace wallet drift', NOW(6), 1);

UPDATE order_delivery SET refunded_at = NOW(6) WHERE id = @new_delivery_id;

-- C6. legacy mirror (미정산 → all_settle_amount 차감)
UPDATE `user` SET all_settle_amount = all_settle_amount - @amount WHERE id = @billing_user_id;


-- =============================================================================
-- SECTION D. 사후검증 (COMMIT 전, 트랜잭션 내에서 확인)
-- =============================================================================

-- D1. line repoint 됐는지  → expect: order_delivery_id = 623012
SELECT 'D1' AS chk, id, order_delivery_id FROM order_payment_allocation_line WHERE id = @line_id;

-- D2. 신규 delivery attempt 생겼는지  → expect: 1행 INITIAL/DEDUCTED
SELECT 'D2' AS chk, id, order_delivery_id, attempt_type, status
  FROM order_delivery_attempt WHERE order_delivery_id = @new_delivery_id;

-- D3. refund_event 기록  → expect: refunded_credit_used_amount=300, 나머지 0
SELECT 'D3' AS chk, id, event_type, affected_delivery_ids,
       refunded_credit_used_amount, refunded_deposit_amount, refunded_point_amount,
       refunded_credit_excess_amount, idempotency_key
  FROM order_payment_refund_event WHERE idempotency_key = @idem;

-- D4. wallet_account credit_used -300 검증  → expect: credit_used_before - 300
SELECT 'D4' AS chk, id, credit_used_amount AS credit_used_after FROM wallet_account WHERE id = @wallet_account_id;

-- D5. wallet_transaction 기록  → expect: amount=-300, balance_after=credit_used_after
SELECT 'D5' AS chk, id, type, resource_type, amount, balance_after, idempotency_key
  FROM wallet_transaction WHERE idempotency_key = CONCAT(@idem, ':credit');

-- D6. refund_ledger + refunded_at  → expect: 1행 / refunded_at NOT NULL
SELECT 'D6' AS chk,
       (SELECT COUNT(*) FROM order_delivery_refund WHERE order_delivery_id = @new_delivery_id) AS ledger_cnt,
       (SELECT refunded_at FROM order_delivery WHERE id = @new_delivery_id) AS refunded_at;

-- D7. legacy mirror -300 검증  → expect: all_settle_before - 300
SELECT 'D7' AS chk, id, all_settle_amount AS all_settle_after FROM `user` WHERE id = @billing_user_id;

-- D8. allocation credit 잔액 정합 (선택) — 라인 합 vs 복구 합
SELECT 'D8' AS chk,
       (SELECT SUM(credit_used_amount) FROM order_payment_allocation_line WHERE allocation_id = @allocation_id) AS line_credit_sum,
       (SELECT credit_used_restored_amount FROM order_payment_allocation WHERE id = @allocation_id) AS credit_restored;
-- 이 주문이 전부 폐기/환불됐다면 두 값이 같아야 함(line_credit_sum == credit_restored).


-- =============================================================================
-- 검증 정상 → COMMIT;   /   이상 → ROLLBACK;
-- =============================================================================
-- COMMIT;
-- ROLLBACK;
