-- 환불관리 목록(`GET /settle/refund/list`) 조회 성능 보강.
-- 목록·건수·총 환불금액 세 쿼리가 모두 `refund_status IS NOT NULL` 로 같은 모집단을 잡고,
-- 그중 목록 쿼리만 `refund_register_at DESC, id DESC` 로 정렬한다
-- (집계는 ONLY_FULL_GROUP_BY 때문에 정렬을 물려받지 않는다 — refund.service.ts 의 clone 위치).
-- 두 컬럼 어디에도 인덱스가 없다.
--
-- 2026-08-18 운영 실측: order_delivery 305,060행 중 refund_status IS NOT NULL 은 102행(0.03%).
-- 그런데 옵티마이저가 order_delivery 를 드라이빙으로 잡지 못해(user → order → mapping → delivery 순),
-- 102행을 얻는 데 order_product_mapping_id 인덱스로 약 302,000행을 훑고 EXPLAIN ANALYZE 기준 1,021ms 가 걸린다.
-- 비용이 환불건 수가 아니라 order_delivery 총 행수에 비례하므로 환불건이 늘지 않아도 계속 느려진다.
-- 이 인덱스가 있으면 order_delivery 가 드라이빙이 되어 102행만 읽고 나머지는 PK 조인으로 끝난다.
--
-- 컬럼 순서: refund_status 가 선두여야 0.03% 선택도로 모집단을 먼저 좁힌다.
--   - 기본 조회(refund_status IS NOT NULL)는 range 스캔이라 후행 컬럼으로 정렬까지 처리하지는 못하지만,
--     102행 수준의 filesort 라 무시할 수 있다.
--   - 상태 필터를 지정한 조회(refund_status = ?)는 equality 라 refund_register_at 정렬까지 인덱스로 처리된다.
--   - id 는 InnoDB secondary index 에 항상 포함되므로 명시하지 않는다.
--
-- ★ 적용 시점 — 발송이 없는 시간대에 실행할 것 (운영자 수동 발송이라 18시 이후가 안전).
--
--   ALGORITHM=INPLACE, LOCK=NONE 이라 인덱스 빌드 중에는 읽기·쓰기가 계속되고 305k 행 빌드 자체는 수 초다.
--   위험한 구간은 빌드가 아니라 DDL 의 **시작·종료 시 필요한 메타데이터 락(MDL)** 이다.
--   order_delivery 를 잡은 트랜잭션이 하나라도 길게 열려 있으면 DDL 이 MDL 대기에 걸리고,
--   그 뒤에 도착하는 모든 쿼리가 DDL 뒤에 줄을 서서 발송이 통째로 멈춘다.
--   아래 lock_wait_timeout 은 그 상황에서 DDL 이 큐를 막지 않고 **먼저 실패하도록** 하는 안전장치다
--   (실패하면 장기 트랜잭션이 끝난 뒤 재실행하면 된다 — 이 스크립트는 멱등이다).
--
--   실행 전 장기 트랜잭션 확인:
--     SELECT trx_id, trx_started, trx_mysql_thread_id, trx_query
--     FROM information_schema.INNODB_TRX
--     WHERE trx_started < NOW() - INTERVAL 5 SECOND;
--
-- 상시 운영 부담: 신규 발송건 INSERT 당 인덱스 엔트리 1개. 두 컬럼이 갱신되는 곳은 환불 접수
-- (refund_register_at)와 환불관리 화면의 상태 전이(refund_status: PROGRESS→APPROVE→COMPLETE)뿐이고,
-- 발송 배치가 바꾸는 status·actual_send_at·claimed_at 은 이 인덱스에 없다. 즉 발송 UPDATE 는
-- 이 인덱스를 건드리지 않는다.
--
-- 적용 전 확인:
--   SHOW INDEX FROM `order_delivery` WHERE Key_name = 'idx_order_delivery_refund_status_register_at';
--
-- 적용 후 확인:
--   1) SHOW INDEX 결과가 Seq_in_index=1 refund_status, Seq_in_index=2 refund_register_at,
--      Non_unique=1, Sub_part=NULL, Index_type=BTREE 인지 확인한다.
--   2) 아래 집계 쿼리 EXPLAIN 에서 드라이빙 테이블이 od 로 바뀌고 이 인덱스가 선택되는지 확인한다.
--      EXPLAIN SELECT SUM(CAST(COALESCE(opm.snapshot_product_price, p.price, 0) * od.refund_ratio AS DECIMAL(20,4)) / 100)
--      FROM order_delivery od
--      INNER JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id AND opm.deleted_at IS NULL
--      INNER JOIN product p ON p.id = opm.product_id AND p.deleted_at IS NULL
--      INNER JOIN `order` o ON o.id = opm.order_id AND o.deleted_at IS NULL
--      INNER JOIN `user` u ON u.id = o.user_id AND u.deleted_at IS NULL
--      LEFT JOIN user_company c ON c.id = u.company_id AND c.deleted_at IS NULL
--      WHERE od.deleted_at IS NULL AND od.refund_status IS NOT NULL;

-- MDL 대기로 뒤따르는 쿼리를 막지 않도록, 못 잡으면 DDL 이 먼저 실패한다.
SET SESSION lock_wait_timeout = 5;

SET @idx_exists := (
  SELECT COUNT(DISTINCT INDEX_NAME)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_delivery'
    AND INDEX_NAME = 'idx_order_delivery_refund_status_register_at'
);

SET @idx_ok := (
  SELECT
    COUNT(*) = 2
    AND SUM(CASE WHEN SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'refund_status' AND NON_UNIQUE = 1 AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'refund_register_at' AND NON_UNIQUE = 1 AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' THEN 1 ELSE 0 END) = 1
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_delivery'
    AND INDEX_NAME = 'idx_order_delivery_refund_status_register_at'
);

SET @drop_sql := IF(
  @idx_exists > 0 AND @idx_ok = 0,
  'ALTER TABLE `order_delivery` DROP INDEX `idx_order_delivery_refund_status_register_at`, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);

PREPARE s FROM @drop_sql;
EXECUTE s;
DEALLOCATE PREPARE s;

SET @create_sql := IF(
  @idx_ok = 0,
  'ALTER TABLE `order_delivery` ADD INDEX `idx_order_delivery_refund_status_register_at` (`refund_status`, `refund_register_at`), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);

PREPARE s FROM @create_sql;
EXECUTE s;
DEALLOCATE PREPARE s;

-- 검증
SHOW INDEX FROM `order_delivery` WHERE Key_name = 'idx_order_delivery_refund_status_register_at';

-- 롤백 (코드 롤백 후에만 실행)
-- DROP INDEX `idx_order_delivery_refund_status_register_at` ON `order_delivery`;
