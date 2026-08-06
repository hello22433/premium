-- 컷오버 환불의 refund_attempt와 실제 멱등 원장(order_delivery_refund)을 영구 연결한다.
-- legacy 환불 행은 두 컬럼이 NULL이며 기존 동작을 유지한다.

ALTER TABLE `order_delivery_refund`
  ADD COLUMN `refund_attempt_id` BIGINT NULL
    COMMENT 'FK) refund_attempt.id. 컷오버 환불 실행 근거',
  ADD COLUMN `external_idempotency_key` VARCHAR(191) NULL
    COMMENT 'refund_attempt.external_idempotency_key. 실제 환불 멱등 원장 연결 키',
  ADD UNIQUE KEY `uk_order_delivery_refund_attempt` (`refund_attempt_id`),
  ADD UNIQUE KEY `uk_order_delivery_refund_external_idem` (`external_idempotency_key`);

-- 검증
-- SELECT r.order_delivery_id, r.refund_attempt_id, r.external_idempotency_key
--   FROM order_delivery_refund r
--   JOIN delivery_workflow w ON w.order_delivery_id = r.order_delivery_id
--  WHERE w.cutover_migrated_at IS NOT NULL
--    AND (r.refund_attempt_id IS NULL OR r.external_idempotency_key IS NULL);
-- 기대: 0행
