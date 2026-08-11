-- =============================================================================
-- autosettle-snapshot-backfill.sql
--
-- 목적: 배치 자동 정산확정(delivery.batch autoSettlePrePaymentOrders)이 settle_status 만 바꾸고
--       is_settle_complete / settled_amount_snapshot 을 비워둔 기존 주문을 정상화한다.
--         is_settle_complete = 1
--         settled_amount_snapshot = correct_snapshot (정산확정 경로 netAmount 와 동일 재계산)
--
-- 코드 수정(같은 PR): delivery.batch.service.ts autoSettlePrePaymentOrders 가 이제 3컬럼을 함께 기록.
--                    settle-fee.util.ts computeSettleNetAmountByOrder 가 netAmount SoT.
-- 배경 진단: 루트 diagnose-autosettle-snapshot-140.sql. 실현된 금액 차이는 0건이지만
--           카드할증 주문은 CS 폐기가 들어오면 즉시 갈리므로 기존 건도 백필로 정상화한다.
--
-- ── SoT 정합성 (중요) ────────────────────────────────────────────────────────
-- correct_snapshot 은 computeSettleNetAmountByOrder 와 동일 규칙으로 재계산한다:
--   base_i           = OrderFeeCalculator(effective fee/priceAdjustment, readLineProductView price)
--   correct_snapshot = applyCardSurcharge(Σ base_i, card_surcharge_applied)   (주문 합계에 1회)
-- 정산유효 발송건 집계 규칙(코드와 일치):
--   · status COMPLETE/COMPLETE_SMS 만
--   · couponStatus = CANCEL(고객사 폐기)만 제외.  REFUND_CANCEL(수령고객 환불)은 고객사 정산 100% 유지 → 포함.
--   · 단, "확정 이후 CS 폐기되어 지금 CANCEL 인" 발송건은 확정시점 스냅샷 복원을 위해 다시 포함
--     (CS_DISCARD 이력이 있으면 재포함). 확정 시점엔 유효했고, 폐기 복원 안분이 이 스냅샷을 기준으로 한다.
--
-- 대상 한정(자동정산 victim 만): 세 컬럼 상태 + is_settle_balance=1 + 과금대상 settle_condition=PRE_PAYMENT.
--   (정상 정산확정 tryAtomicSettleConfirm 은 3컬럼을 함께 쓰고, 정산해제는 settle_status 를 벗어나므로
--    이 상태는 버그 배치 경로에서만 생기지만, 안전을 위해 배치 필터와 동일 조건으로 좁힌다.)
--
-- 실행: MySQL 8+. [S0] 대상 외 이상건 점검 → [S1] 프리뷰 → [S2] 트랜잭션 UPDATE → 검증 후 COMMIT.
--       각 스텝의 WITH 절은 독립적이다.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- [S0] 안전 점검 — 세 컬럼 상태이지만 "자동정산 대상 필터(is_settle_balance=1 & PRE_PAYMENT)"에
--   걸리지 않는 이상 주문이 있는지 확인한다. 결과가 나오면 백필 전에 원인 규명(백필 대상 아님).
SELECT
  o.id,
  o.is_settle_balance,
  bu.settle_condition,
  o.type,
  o.status
FROM `order` o
JOIN `user` bu ON bu.id = COALESCE(o.client_user_id, o.user_id)
WHERE o.settle_status = 'SETTLE_COMPLETE'
  AND o.is_settle_complete = 0
  AND o.settled_amount_snapshot IS NULL
  AND NOT (o.is_settle_balance = 1 AND bu.settle_condition = 'PRE_PAYMENT')
ORDER BY o.id;


-- ─────────────────────────────────────────────────────────────────────────────
-- [S1] 프리뷰 — 백필될 주문과 채워질 값 (읽기 전용). base_line_cnt=0 은 snapshot 0 으로 확정된다.
WITH stuck AS (
  SELECT o.id, o.card_surcharge_applied
  FROM `order` o
  JOIN `user` bu ON bu.id = COALESCE(o.client_user_id, o.user_id)
  WHERE o.settle_status = 'SETTLE_COMPLETE'
    AND o.is_settle_complete = 0
    AND o.settled_amount_snapshot IS NULL
    AND o.is_settle_balance = 1
    AND bu.settle_condition = 'PRE_PAYMENT'
),
del AS (
  SELECT s.id AS order_id,
         COALESCE(m.snapshot_product_price, p.price, 0)          AS eff_price,
         COALESCE(d.settle_fee, m.fee)                            AS eff_fee,
         COALESCE(d.settle_price_adjustment, m.price_adjustment)  AS eff_adj
  FROM stuck s
  JOIN order_product_mapping m ON m.order_id = s.id
  JOIN order_delivery d        ON d.order_product_mapping_id = m.id
  LEFT JOIN product p          ON p.id = m.product_id
  WHERE d.status IN ('COMPLETE', 'COMPLETE_SMS')
    AND d.deleted_at IS NULL
    AND (
          d.coupon_status IS NULL
       OR d.coupon_status <> 'CANCEL'
       OR EXISTS (SELECT 1 FROM order_delivery_refund rf2
                   WHERE rf2.order_delivery_id = d.id AND rf2.source_path = 'CS_DISCARD')
        )
),
del_base AS (
  SELECT order_id,
         CASE
           WHEN eff_fee IS NOT NULL AND eff_adj IS NOT NULL AND eff_fee <> 0 THEN
             CASE eff_adj
               WHEN 'DISCOUNT'   THEN eff_price - ROUND(eff_fee / 100 * eff_price)
               WHEN 'ADDITIONAL' THEN eff_price + ROUND(eff_fee / 100 * eff_price)
               ELSE eff_price
             END
           ELSE eff_price
         END AS base_amount
  FROM del
),
per_order AS (
  SELECT s.id AS order_id,
         s.card_surcharge_applied,
         COALESCE(SUM(db.base_amount), 0) AS total_base,
         COUNT(db.order_id)               AS base_line_cnt
  FROM stuck s
  LEFT JOIN del_base db ON db.order_id = s.id
  GROUP BY s.id, s.card_surcharge_applied
)
SELECT
  po.order_id,
  po.card_surcharge_applied,
  po.base_line_cnt,
  po.total_base,
  CASE WHEN po.card_surcharge_applied = 1
       THEN FLOOR((po.total_base + ROUND(po.total_base * 0.03)) / 10) * 10
       ELSE po.total_base END AS correct_snapshot,
  CASE WHEN po.base_line_cnt = 0 THEN 'ZERO_snapshot0_확정' ELSE 'ok' END AS note
FROM per_order po
ORDER BY (po.base_line_cnt = 0) DESC, po.card_surcharge_applied DESC, po.order_id;


-- ─────────────────────────────────────────────────────────────────────────────
-- [S2] 백필 실행 — 트랜잭션. 신규 코드와 동일하게 base_line_cnt=0 도 snapshot 0 으로 확정한다
--   (LEFT JOIN + COALESCE → drift 잔존 없음). 검증 SELECT 확인 후 COMMIT.
START TRANSACTION;

WITH stuck AS (
  SELECT o.id, o.card_surcharge_applied
  FROM `order` o
  JOIN `user` bu ON bu.id = COALESCE(o.client_user_id, o.user_id)
  WHERE o.settle_status = 'SETTLE_COMPLETE'
    AND o.is_settle_complete = 0
    AND o.settled_amount_snapshot IS NULL
    AND o.is_settle_balance = 1
    AND bu.settle_condition = 'PRE_PAYMENT'
),
del AS (
  SELECT s.id AS order_id,
         COALESCE(m.snapshot_product_price, p.price, 0)          AS eff_price,
         COALESCE(d.settle_fee, m.fee)                            AS eff_fee,
         COALESCE(d.settle_price_adjustment, m.price_adjustment)  AS eff_adj
  FROM stuck s
  JOIN order_product_mapping m ON m.order_id = s.id
  JOIN order_delivery d        ON d.order_product_mapping_id = m.id
  LEFT JOIN product p          ON p.id = m.product_id
  WHERE d.status IN ('COMPLETE', 'COMPLETE_SMS')
    AND d.deleted_at IS NULL
    AND (
          d.coupon_status IS NULL
       OR d.coupon_status <> 'CANCEL'
       OR EXISTS (SELECT 1 FROM order_delivery_refund rf2
                   WHERE rf2.order_delivery_id = d.id AND rf2.source_path = 'CS_DISCARD')
        )
),
del_base AS (
  SELECT order_id,
         CASE
           WHEN eff_fee IS NOT NULL AND eff_adj IS NOT NULL AND eff_fee <> 0 THEN
             CASE eff_adj
               WHEN 'DISCOUNT'   THEN eff_price - ROUND(eff_fee / 100 * eff_price)
               WHEN 'ADDITIONAL' THEN eff_price + ROUND(eff_fee / 100 * eff_price)
               ELSE eff_price
             END
           ELSE eff_price
         END AS base_amount
  FROM del
),
target AS (
  SELECT s.id AS order_id,
         CASE WHEN s.card_surcharge_applied = 1
              THEN FLOOR((COALESCE(SUM(db.base_amount), 0) + ROUND(COALESCE(SUM(db.base_amount), 0) * 0.03)) / 10) * 10
              ELSE COALESCE(SUM(db.base_amount), 0) END AS correct_snapshot
  FROM stuck s
  LEFT JOIN del_base db ON db.order_id = s.id
  GROUP BY s.id, s.card_surcharge_applied
)
UPDATE `order` o
JOIN target t ON t.order_id = o.id
SET o.is_settle_complete = 1,
    o.settled_amount_snapshot = t.correct_snapshot
WHERE o.settle_status = 'SETTLE_COMPLETE'
  AND o.is_settle_complete = 0
  AND o.settled_amount_snapshot IS NULL
  AND o.is_settle_balance = 1;

-- 검증: 자동정산 대상 중 남은 미정상 건수 (0 이어야 함). [S0] 비대상 이상건은 여기 안 잡힌다.
SELECT COUNT(*) AS remaining_target_stuck
FROM `order` o
JOIN `user` bu ON bu.id = COALESCE(o.client_user_id, o.user_id)
WHERE o.settle_status = 'SETTLE_COMPLETE'
  AND o.is_settle_complete = 0
  AND o.settled_amount_snapshot IS NULL
  AND o.is_settle_balance = 1
  AND bu.settle_condition = 'PRE_PAYMENT';

-- COMMIT;    -- ← 검증(0) 확인 후 주석 해제하여 확정
-- ROLLBACK;  -- ← 문제 있으면 롤백
