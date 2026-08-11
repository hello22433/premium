-- ERP 197-32 수신자별 운영자 메모 컬럼 추가/정합화 (멱등)
-- 기존 행은 NULL을 유지한다.

SET @delivery_col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_delivery'
    AND COLUMN_NAME = 'memo'
);
SET @delivery_col_valid := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_delivery'
    AND COLUMN_NAME = 'memo'
    AND LOWER(COLUMN_TYPE) = 'varchar(500)'
    AND IS_NULLABLE = 'YES'
);
SET @ddl := IF(
  @delivery_col_exists = 0,
  'ALTER TABLE order_delivery ADD COLUMN memo VARCHAR(500) NULL COMMENT ''수신자별 운영자 메모 (고객 미노출, 치환 대상 아님)'' AFTER replace_character3, ALGORITHM=INSTANT',
  IF(
    @delivery_col_valid = 0,
    'ALTER TABLE order_delivery MODIFY COLUMN memo VARCHAR(500) NULL COMMENT ''수신자별 운영자 메모 (고객 미노출, 치환 대상 아님)''',
    'SELECT 1'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @manual_col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_manual_entry'
    AND COLUMN_NAME = 'memo'
);
SET @manual_col_valid := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_manual_entry'
    AND COLUMN_NAME = 'memo'
    AND LOWER(COLUMN_TYPE) = 'varchar(500)'
    AND IS_NULLABLE = 'YES'
);
SET @ddl := IF(
  @manual_col_exists = 0,
  'ALTER TABLE order_manual_entry ADD COLUMN memo VARCHAR(500) NULL COMMENT ''수신자별 운영자 메모 (고객 미노출, 치환 대상 아님)'' AFTER replace_character3, ALGORITHM=INSTANT',
  IF(
    @manual_col_valid = 0,
    'ALTER TABLE order_manual_entry MODIFY COLUMN memo VARCHAR(500) NULL COMMENT ''수신자별 운영자 메모 (고객 미노출, 치환 대상 아님)''',
    'SELECT 1'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @invalid_column_count := (
  SELECT 2 - COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('order_delivery', 'order_manual_entry')
    AND COLUMN_NAME = 'memo'
    AND LOWER(COLUMN_TYPE) = 'varchar(500)'
    AND IS_NULLABLE = 'YES'
);
DROP PROCEDURE IF EXISTS validate_erp_197_32_memo_columns;
DELIMITER $$
CREATE PROCEDURE validate_erp_197_32_memo_columns()
BEGIN
  IF @invalid_column_count <> 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ERP-197-32 memo column definition mismatch';
  END IF;
END$$
DELIMITER ;

CALL validate_erp_197_32_memo_columns();
DROP PROCEDURE validate_erp_197_32_memo_columns;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('order_delivery', 'order_manual_entry')
  AND COLUMN_NAME = 'memo'
ORDER BY TABLE_NAME;
