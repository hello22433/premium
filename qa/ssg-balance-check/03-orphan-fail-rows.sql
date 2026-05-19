-- SSG 실패인데 ledger 또는 refundedAt 누락된 row 탐지
-- plans/ssg-balance-refactor.md PR5
--
-- 정상 흐름이라면 SSG order_delivery.status=FAIL 이면 refundForFail() 호출되어
-- order_delivery_refund row + order_delivery.refunded_at 가 둘 다 채워져 있어야 한다.
--
-- 두 신호 중 하나라도 누락이면 회귀 후보:
--  - ledger row 없음 = phaseC 트랜잭션 부분 rollback / refundForFail throw
--  - refundedAt NULL = stale-save 회귀 (다른 save/update 가 NULL 로 덮어씀)
--  - 둘 다 누락 = legacy / 비정상 흐름
--
-- 결과 컬럼 missing_ledger, missing_refunded_at 플래그로 어느 신호가 깨졌는지 구분.

SELECT
  od.id AS order_delivery_id,
  od.status,
  od.bar_code,
  od.ssg_event_id,
  od.failed_at,
  od.refunded_at,
  od.created_at,
  o.id AS order_id,
  o.type AS order_type,
  o.code AS order_code,
  st.state AS insert_state,
  r.id AS refund_ledger_id,
  (r.id IS NULL) AS missing_ledger,
  (od.refunded_at IS NULL) AS missing_refunded_at
FROM order_delivery od
JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
JOIN `order` o ON o.id = opm.order_id
LEFT JOIN order_delivery_refund r ON r.order_delivery_id = od.id
LEFT JOIN order_delivery_ssg_insert_state st ON st.order_delivery_id = od.id
WHERE o.type = 'SSG'
  AND od.status IN ('FAIL', 'FAIL_SMS')
  AND (r.id IS NULL OR od.refunded_at IS NULL)
  -- 마이그레이션 이전 row 제외 옵션 (필요 시 주석 해제)
  -- AND od.failed_at >= '2026-05-19 00:00:00'
ORDER BY od.failed_at DESC;
