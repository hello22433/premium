-- 협력사 정산 발송내역 조회(order_delivery.actual_send_at 기간 필터) 성능 보강.
-- 목록/엑셀 모두 actual_send_at 기준으로 발송건을 찾고 id 역순으로 페이지/청크 처리한다.
--
-- 적용 전 확인:
--   SHOW INDEX FROM `order_delivery` WHERE Key_name = 'idx_order_delivery_actual_send_at';
--   운영에 같은 이름의 actual_send_at 단일 인덱스가 있으면 아래 DDL이 (actual_send_at, id) 복합 인덱스로 교체한다.
--   (actual_send_at, id)는 actual_send_at 단일 조회에도 left-prefix로 사용할 수 있다.
--
-- 적용 후 확인:
--   1) SHOW INDEX 결과가 Seq_in_index=1 actual_send_at, Seq_in_index=2 id, Non_unique=1, Sub_part=NULL, Index_type=BTREE 인지 확인한다.
--   2) 협력사 정산 목록/엑셀 id 수집 쿼리 EXPLAIN 에서 actual_send_at 기간 필터와 정렬에 이 인덱스가 선택되는지 확인한다.

SET @idx_exists := (
  SELECT COUNT(DISTINCT INDEX_NAME)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_delivery'
    AND INDEX_NAME = 'idx_order_delivery_actual_send_at'
);

SET @idx_ok := (
  SELECT
    COUNT(*) = 2
    AND SUM(CASE WHEN SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'actual_send_at' AND NON_UNIQUE = 1 AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'id' AND NON_UNIQUE = 1 AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' THEN 1 ELSE 0 END) = 1
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_delivery'
    AND INDEX_NAME = 'idx_order_delivery_actual_send_at'
);

SET @drop_sql := IF(
  @idx_exists > 0 AND @idx_ok = 0,
  'ALTER TABLE `order_delivery` DROP INDEX `idx_order_delivery_actual_send_at`, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);

PREPARE s FROM @drop_sql;
EXECUTE s;
DEALLOCATE PREPARE s;

SET @create_sql := IF(
  @idx_ok = 0,
  'ALTER TABLE `order_delivery` ADD INDEX `idx_order_delivery_actual_send_at` (`actual_send_at`, `id`), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);

PREPARE s FROM @create_sql;
EXECUTE s;
DEALLOCATE PREPARE s;

-- 검증
SHOW INDEX FROM `order_delivery` WHERE Key_name = 'idx_order_delivery_actual_send_at';

-- 롤백 (코드 롤백 후에만 실행)
-- DROP INDEX `idx_order_delivery_actual_send_at` ON `order_delivery`;
