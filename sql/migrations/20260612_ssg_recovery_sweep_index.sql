-- SSG 행사 잔액 복구 sweep 후보 조회 성능 인덱스.
-- docs/plans/2026-06-12-external-api-wallet-integration.md B-7.
--
-- sweep 후보 WHERE 절:
--   ssg_balance_settled = false
--   AND (ssg_recover_lease_until IS NULL OR ssg_recover_lease_until < NOW(6))
-- 미보정 + lease 만료 row 만 빠르게 스캔하기 위한 복합 인덱스.

ALTER TABLE order_delivery_refund
  ADD INDEX idx_ssg_sweep (ssg_balance_settled, ssg_recover_lease_until);
