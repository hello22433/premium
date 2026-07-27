-- 협력사 정산 발송내역 actual_send_at 누락 진단 및 제한적 백필 초안.
-- 적용 원칙:
--   1) 협력사 정산 메뉴는 발송건 단위 조회이며, 프론트 계약상 발송일은 actual_send_at 기준이다.
--   2) 이 SQL은 성공 이력이 있는데 actual_send_at 이 NULL 이라 actual_send_at 기간 필터에서
--      조용히 누락되는 후보를 확인하기 위한 것이다.
--   3) SELECT 진단 결과를 먼저 저장/검토한다.
--   4) 백필은 후보가 실제 성공 발송 누락으로 확인된 경우에만 주석을 해제해 실행한다.

-- ============================================================================
-- 진단 1: 성공 이력은 있으나 actual_send_at 이 비어 협력사 정산 발송일 조회에서 누락될 후보 수.
-- ============================================================================

SELECT
  COUNT(DISTINCT od.id) AS missing_actual_send_at_success_count
FROM order_delivery od
JOIN delivery_send_history dsh
  ON dsh.order_delivery_id = od.id
 AND dsh.is_success = 1
JOIN order_product_mapping opm
  ON opm.id = od.order_product_mapping_id
JOIN `order` o
  ON o.id = opm.order_id
WHERE o.status IN ('DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE')
  AND od.actual_send_at IS NULL;

-- ============================================================================
-- 진단 2: 후보 샘플. 채널/status/성공 이력 시각을 보고 자동 백필 가능한지 검토한다.
-- ============================================================================

SELECT
  od.id AS order_delivery_id,
  o.id AS order_id,
  o.status AS order_status,
  od.status AS delivery_status,
  od.coupon_status,
  od.delivery_method,
  od.send_request_at,
  od.actual_send_at,
  MIN(dsh.created_at) AS first_success_history_at,
  COUNT(dsh.id) AS success_history_count
FROM order_delivery od
JOIN delivery_send_history dsh
  ON dsh.order_delivery_id = od.id
 AND dsh.is_success = 1
JOIN order_product_mapping opm
  ON opm.id = od.order_product_mapping_id
JOIN `order` o
  ON o.id = opm.order_id
WHERE o.status IN ('DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE')
  AND od.actual_send_at IS NULL
GROUP BY
  od.id,
  o.id,
  o.status,
  od.status,
  od.coupon_status,
  od.delivery_method,
  od.send_request_at,
  od.actual_send_at
ORDER BY od.id DESC
LIMIT 100;

-- ============================================================================
-- 제한적 백필: 위 후보가 실제 성공 발송 누락으로 확인된 경우만 실행.
-- 성공 이력이 없는 실패/미발송 건은 채우지 않는다.
-- ============================================================================

-- START TRANSACTION;
-- UPDATE order_delivery od
-- JOIN (
--   SELECT
--     order_delivery_id,
--     MIN(created_at) AS first_success_history_at
--   FROM delivery_send_history
--   WHERE is_success = 1
--     AND order_delivery_id IS NOT NULL
--   GROUP BY order_delivery_id
-- ) dsh
--   ON dsh.order_delivery_id = od.id
-- JOIN order_product_mapping opm
--   ON opm.id = od.order_product_mapping_id
-- JOIN `order` o
--   ON o.id = opm.order_id
-- SET od.actual_send_at = dsh.first_success_history_at
-- WHERE o.status IN ('DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE')
--   AND od.actual_send_at IS NULL;
--
-- SELECT ROW_COUNT() AS backfilled_rows;
-- COMMIT;
