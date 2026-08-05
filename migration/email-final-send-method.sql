-- 이메일 쿠폰 최종 발신 수단 컬럼 추가 (멱등)
-- 실행 시점: feature/erp-197-30-email-final-send-method 배포 전.
-- 목적: order_product_mapping 에 email_final_send_method 신설.
--   NULL = 레거시(현행 알림톡 우선 → MMS 폴백).
--   'ALIM_TALK' = 알림톡 우선 → MMS 폴백 (NULL 과 동일 동작).
--   'MMS' = MMS 직행, 폴백 없음 (P-a 비대칭 정책).
-- behavior-preserving: 기존 행은 NULL 유지, 현행 동작 불변.

-- ── UP: ADD COLUMN (이미 있으면 no-op) ──
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_product_mapping'
    AND COLUMN_NAME = 'email_final_send_method'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE order_product_mapping
     ADD COLUMN email_final_send_method VARCHAR(100) NULL
     COMMENT ''이메일 쿠폰 최종 발신 수단(ALIM_TALK|MMS). NULL=레거시(현행 알림톡 우선)''
     AFTER email_send_type,
     ALGORITHM=INSTANT',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 검증: 컬럼 존재 확인 ──
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'order_product_mapping'
  AND COLUMN_NAME = 'email_final_send_method';

-- ── DOWN (롤백) ──
-- SET @col_exists := (
--   SELECT COUNT(*)
--   FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'order_product_mapping'
--     AND COLUMN_NAME = 'email_final_send_method'
-- );
--
-- SET @ddl := IF(
--   @col_exists > 0,
--   'ALTER TABLE order_product_mapping DROP COLUMN email_final_send_method',
--   'SELECT 1'
-- );
--
-- PREPARE stmt FROM @ddl;
-- EXECUTE stmt;
-- DEALLOCATE PREPARE stmt;
