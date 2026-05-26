-- Wallet Cutover — Legacy Reconciler (Gap 2 → Gap 1 도구)
-- =====================================================
--
-- 목적:
--   wallet 백필(20260521_backfill.sql) 실행 전 legacy 데이터 (user.all_settle_amount,
--   user_company.balance, user_company.maximum_limit, order.settleAmount/isSettleBalance/
--   isCreditExcess) 가 일관성을 유지하는지 독립 재구성 + 차분(drift) 출력.
--
-- 원천 (source-of-truth):
--   order + order_product_mapping + order_delivery (사용자 합의 — 환불 ledger 미포함).
--   각 order 의 status / isSettleBalance / isCreditExcess / isSettleComplete /
--   settleAmount 를 기준으로 user.all_settle_amount 기대값을 재구성한다.
--
-- 실행:
--   read-only. console 출력만. 결과 row 가 있으면 운영자 검토 + 수동 보정 후
--   20260521_backfill.sql 실행.
--
-- 검사:
--   A) 음수 all_settle_amount — 직접 오염 시그널 (-36,472 사건 패턴).
--   B) 주문 합계 vs all_settle_amount mismatch (drift) — 양수/음수 양방향.
--   C) 회사 단위 SUM(all_settle_amount) > maximum_limit — 한도 초과.
--   D) 발송확정/주문 cancel 사이 상태 incoherence (참고용).
--
-- 한계:
--   - 부분 발송 실패 (한 order 의 일부 delivery FAIL) 시 order.settleAmount 가 그대로
--     남아있으면 expected 가 over-estimate. 운영자가 detail 확인 필요.
--   - balance / user_company.balance 재구성은 ledger 부재로 skip — 음수만 잡음.
--   - order_payment_refund_event 미포함 (PR2 이후 발생분만 있어 backfill 시점에는 0).

-- ============================================================================
-- A) 음수 all_settle_amount — 직접 오염
-- ============================================================================
SELECT '--- A) 음수 all_settle_amount ---' AS section;

SELECT u.id AS user_id, u.email, u.company_id, u.all_settle_amount
  FROM `user` u
 WHERE u.all_settle_amount < 0
 ORDER BY u.all_settle_amount ASC;

-- ============================================================================
-- B) 주문 합계 vs all_settle_amount drift
-- ============================================================================
-- 기대값 정의:
--   billing_user_id = COALESCE(order.client_user_id, order.user_id)
--   active credit order = order WHERE
--     status NOT IN ('TEMP', 'DELIVERY_CANCEL', 'DELETED')
--     AND is_settle_complete = 0
--     AND (is_settle_balance = 0 OR is_credit_excess = 1)
--   expected_all_settle = SUM(order.settle_amount) per billing_user_id
--
-- 비교:
--   drift = u.all_settle_amount - expected
--   양수 = legacy 가 더 많음 (환불 덜 적용 / 음수 over-charge 위험)
--   음수 = legacy 가 더 적음 (이중 환불 / -36,472 패턴 가능)

SELECT '--- B) 주문 합계 vs all_settle_amount drift ---' AS section;

WITH order_active AS (
  SELECT
    COALESCE(o.client_user_id, o.user_id) AS billing_user_id,
    o.id AS order_id,
    o.settle_amount,
    o.status,
    o.is_settle_balance,
    o.is_credit_excess,
    o.is_settle_complete
  FROM `order` o
  WHERE o.status NOT IN ('TEMP', 'DELIVERY_CANCEL', 'DELETED')
    AND o.is_settle_complete = 0
    AND (o.is_settle_balance = 0 OR o.is_credit_excess = 1)
),
expected_per_user AS (
  SELECT
    billing_user_id,
    SUM(settle_amount) AS expected_all_settle
  FROM order_active
  GROUP BY billing_user_id
)
SELECT
  u.id AS user_id,
  u.email,
  u.company_id,
  u.all_settle_amount AS legacy_all_settle,
  COALESCE(e.expected_all_settle, 0) AS expected_all_settle,
  u.all_settle_amount - COALESCE(e.expected_all_settle, 0) AS drift
FROM `user` u
LEFT JOIN expected_per_user e ON e.billing_user_id = u.id
WHERE u.all_settle_amount != COALESCE(e.expected_all_settle, 0)
ORDER BY ABS(u.all_settle_amount - COALESCE(e.expected_all_settle, 0)) DESC;

-- ============================================================================
-- B-2) 회사 단위 drift (wallet 백필이 company 단위 SUM 이므로 보강)
-- ============================================================================
SELECT '--- B-2) 회사 단위 drift ---' AS section;

WITH order_active AS (
  SELECT
    COALESCE(o.client_user_id, o.user_id) AS billing_user_id,
    o.settle_amount,
    o.is_settle_complete,
    o.is_settle_balance,
    o.is_credit_excess,
    o.status
  FROM `order` o
  WHERE o.status NOT IN ('TEMP', 'DELIVERY_CANCEL', 'DELETED')
    AND o.is_settle_complete = 0
    AND (o.is_settle_balance = 0 OR o.is_credit_excess = 1)
),
expected_per_user AS (
  SELECT billing_user_id, SUM(settle_amount) AS expected_all_settle
    FROM order_active GROUP BY billing_user_id
)
SELECT
  c.id AS company_id,
  c.business_name,
  SUM(u.all_settle_amount) AS legacy_total,
  SUM(COALESCE(e.expected_all_settle, 0)) AS expected_total,
  SUM(u.all_settle_amount) - SUM(COALESCE(e.expected_all_settle, 0)) AS drift_total
FROM `user_company` c
JOIN `user` u ON u.company_id = c.id
LEFT JOIN expected_per_user e ON e.billing_user_id = u.id
GROUP BY c.id, c.business_name
HAVING SUM(u.all_settle_amount) != SUM(COALESCE(e.expected_all_settle, 0))
ORDER BY ABS(SUM(u.all_settle_amount) - SUM(COALESCE(e.expected_all_settle, 0))) DESC;

-- ============================================================================
-- C) 회사 단위 maximum_limit 초과
-- ============================================================================
-- 한도가 줄어들었거나 over-charge 누적 케이스.
-- 백필 시 wallet_account.credit_used_amount > credit_limit 형성 → invariant 위반.

SELECT '--- C) 회사 단위 maximum_limit 초과 ---' AS section;

SELECT
  c.id AS company_id,
  c.business_name,
  c.maximum_limit,
  SUM(u.all_settle_amount) AS legacy_total_all_settle,
  SUM(u.all_settle_amount) - c.maximum_limit AS over_limit
FROM `user_company` c
JOIN `user` u ON u.company_id = c.id
GROUP BY c.id, c.business_name, c.maximum_limit
HAVING SUM(u.all_settle_amount) > c.maximum_limit
ORDER BY SUM(u.all_settle_amount) - c.maximum_limit DESC;

-- ============================================================================
-- D) 주문 상태 incoherence (참고용)
-- ============================================================================
-- DELIVERY_CANCEL 인데 isSettleBalance / allSettleAmount 잔존 한 케이스 등.
-- 환불 누락 의심.

SELECT '--- D) 주문 상태 incoherence (참고) ---' AS section;

-- D-1) DELIVERY_CANCEL 인데 isSettleComplete=true 가 아닌 케이스
SELECT
  o.id AS order_id,
  o.user_id,
  o.client_user_id,
  o.status,
  o.settle_amount,
  o.is_settle_balance,
  o.is_credit_excess,
  o.is_settle_complete,
  '취소된 주문인데 미정산' AS note
FROM `order` o
WHERE o.status = 'DELIVERY_CANCEL'
  AND o.is_settle_complete = 0
  AND o.settle_amount > 0
ORDER BY o.canceled_at DESC
LIMIT 100;

-- D-2) 발송확정 + 미정산 + isSettleBalance=true 인데 isCreditExcess=true (서로 배타적이어야)
SELECT
  o.id AS order_id,
  o.user_id,
  o.status,
  o.settle_amount,
  o.is_settle_balance,
  o.is_credit_excess,
  o.is_settle_complete,
  '예치금 차감 + 신용초과 동시 마킹' AS note
FROM `order` o
WHERE o.is_settle_balance = 1
  AND o.is_credit_excess = 1
LIMIT 100;

-- ============================================================================
-- E) 요약 카운트 (운영자 한눈에)
-- ============================================================================
SELECT '--- E) 요약 카운트 ---' AS section;

SELECT
  (SELECT COUNT(*) FROM `user` WHERE all_settle_amount < 0) AS negative_users,
  (SELECT COUNT(*) FROM (
    WITH order_active AS (
      SELECT
        COALESCE(o.client_user_id, o.user_id) AS billing_user_id,
        o.settle_amount,
        o.is_settle_complete,
        o.is_settle_balance,
        o.is_credit_excess,
        o.status
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
  ) t) AS drift_users,
  (SELECT COUNT(*) FROM (
    SELECT c.id
      FROM `user_company` c
      JOIN `user` u ON u.company_id = c.id
     GROUP BY c.id, c.maximum_limit
    HAVING SUM(u.all_settle_amount) > c.maximum_limit
  ) t) AS over_limit_companies;

-- ============================================================================
-- 운영자 절차:
--   1. 위 결과 검토. drift_users / over_limit_companies / negative_users 가 0 이 아니면 보정 필요.
--   2. 보정은 case-by-case — 자동 SQL 미제공 (위험). 운영자가 수동 결정:
--      - 음수 → 0 으로 reset + 회계 보고 (실 외상 사용분 manual ledger 정리).
--      - 양수 drift → 환불/할인 적용 누락 여부 검토 후 case-by-case correction.
--      - over_limit → maximum_limit 상향 또는 강제 정산 후 reset.
--   3. 보정 후 본 스크립트 재실행 → 모든 section 결과 0 row 확인.
--   4. 20260521_backfill.sql 실행 (gate 가 한 번 더 차단).
-- ============================================================================
