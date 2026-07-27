-- 협력사 정산 발송내역 조회(order_delivery.actual_send_at 기간 필터) 성능 보강.
-- 목록/엑셀 모두 actual_send_at 기준으로 발송건을 찾고 id 역순으로 페이지/청크 처리한다.

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_delivery'
    AND INDEX_NAME = 'idx_order_delivery_actual_send_at'
);

SET @sql := IF(
  @idx_exists = 0,
  'CREATE INDEX `idx_order_delivery_actual_send_at` ON `order_delivery` (`actual_send_at`, `id`)',
  'SELECT 1'
);

PREPARE s FROM @sql;
EXECUTE s;
DEALLOCATE PREPARE s;

-- 검증
SHOW INDEX FROM `order_delivery` WHERE Key_name = 'idx_order_delivery_actual_send_at';

-- 롤백 (코드 롤백 후에만 실행)
-- DROP INDEX `idx_order_delivery_actual_send_at` ON `order_delivery`;
