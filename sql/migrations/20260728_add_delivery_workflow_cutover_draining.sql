-- 프리미엄 발송실패 추적·재발송 §9 — 컷오버 quiesce(드레이닝) 컬럼 추가
-- 근거: plans/프리미엄_발송실패_재발송_구상.md §9 「quiesce(드레이닝) 계약 — flip admission race 차단」
-- ============================================================================
-- ⚠ **배포 선행 필수.** 새 코드는 `delivery_workflow` 조회에서 `cutover_draining_at` 을 select 하므로,
--   이 컬럼 없이 배포하면 컷오버 가드·발송 라우팅이 "Unknown column" 으로 전부 실패한다(fail-closed).
--   즉 발송이 멈춘다. **코드 배포 전에** 이 마이그레이션을 먼저 적용한다.
--
-- 20260727_create_delivery_tracking_workflow.sql 에도 같은 컬럼이 CREATE TABLE 에 포함돼 있다
-- (신규 설치 경로). 이미 그 마이그레이션을 적용한 DB 를 위해 이 파일이 따로 존재하며,
-- **양쪽 어느 순서로 실행해도 안전**하도록 컬럼/인덱스 존재 여부를 확인한 뒤 실행한다.
--
-- 환경: MySQL 8.x / MariaDB 10.x 공용. additive only — 기존 데이터·로직 변경 없음.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 컬럼 추가 (이미 있으면 skip)
-- ---------------------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'delivery_workflow'
     AND COLUMN_NAME  = 'cutover_draining_at'
);

SET @ddl = IF(
  @col_exists = 0,
  'ALTER TABLE `delivery_workflow`
     ADD COLUMN `cutover_draining_at` DATETIME(6) NULL
       COMMENT ''컷오버 드레이닝 마크. NOT NULL 이면 legacy 신규 진입 거부(신규 모델도 미시작, quiesce)''
       AFTER `ops_review_reason`',
  'SELECT ''cutover_draining_at already exists — skipped'' AS note'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2. 조회 인덱스 추가 (이미 있으면 skip)
--    가드는 (order_delivery_id, 마크) 로 조회하지만, 드레이닝 잔여 스윕·감사 조회가 마크 단독으로
--    스캔하므로 cutover_migrated_at 과 동일하게 인덱스를 둔다.
-- ---------------------------------------------------------------------------
SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'delivery_workflow'
     AND INDEX_NAME   = 'idx_delivery_workflow_draining'
);

SET @ddl = IF(
  @idx_exists = 0,
  'ALTER TABLE `delivery_workflow` ADD KEY `idx_delivery_workflow_draining` (`cutover_draining_at`)',
  'SELECT ''idx_delivery_workflow_draining already exists — skipped'' AS note'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3. 검증 — 아래가 1 이어야 한다.
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS has_column
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'delivery_workflow'
   AND COLUMN_NAME  = 'cutover_draining_at';

SELECT COUNT(*) AS has_index
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'delivery_workflow'
   AND INDEX_NAME   = 'idx_delivery_workflow_draining';

-- ---------------------------------------------------------------------------
-- 롤백 (코드 롤백 후에만 — 코드가 살아 있으면 조회가 전부 실패한다)
--   ALTER TABLE `delivery_workflow` DROP KEY `idx_delivery_workflow_draining`;
--   ALTER TABLE `delivery_workflow` DROP COLUMN `cutover_draining_at`;
-- ---------------------------------------------------------------------------
