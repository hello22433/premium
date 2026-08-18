-- EP-P30 P1 — ordinal 제약 추가.
--
-- P0 에서 추가한 nullable 컬럼(pin_issue_command_id, issue_ordinal)에 UNIQUE + CHECK 제약을 건다.
-- P1 코드가 이 컬럼을 쓰기 시작하므로, 코드 배포 **전에** 적용해야 한다.
--
-- MySQL 8.0.16+ 필수 (CHECK 제약 집행). 운영 환경 MySQL 8.4.8 확인 완료.
-- 오류 중단 클라이언트로 실행할 것.

DROP PROCEDURE IF EXISTS `p30_p1_alter_ssg_issue_log_constraints`;

DELIMITER //
CREATE PROCEDURE `p30_p1_alter_ssg_issue_log_constraints`()
BEGIN
  DECLARE mysql_major INT;
  DECLARE mysql_minor INT;
  DECLARE mysql_patch INT;

  SET mysql_major = CAST(SUBSTRING_INDEX(@@version, '.', 1) AS UNSIGNED);
  SET mysql_minor = CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(@@version, '.', 2), '.', -1) AS UNSIGNED);
  SET mysql_patch = CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(@@version, '.', 3), '-', 1), '.', -1) AS UNSIGNED);

  IF mysql_major < 8 OR (mysql_major = 8 AND mysql_minor = 0 AND mysql_patch < 16) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'EP-P30 P1: MySQL >= 8.0.16 필수 (CHECK 제약 집행). 현재 버전이 미달합니다.';
  END IF;

  -- UNIQUE(pin_issue_command_id, issue_ordinal) — (command, 차수) 쌍 유일성.
  -- 같은 command 에서 동일 ordinal 의 로그가 2행 이상이면 중복 발급이다.
  -- NULL 쌍(legacy)은 UNIQUE 위반이 되지 않는다(MySQL NULL 처리).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ssg_issue_log'
       AND INDEX_NAME = 'uq_ssg_issue_log_cmd_ordinal'
  ) THEN
    ALTER TABLE `ssg_issue_log`
      ADD UNIQUE KEY `uq_ssg_issue_log_cmd_ordinal` (`pin_issue_command_id`, `issue_ordinal`),
      ALGORITHM=INPLACE, LOCK=NONE;
  END IF;

  -- CHECK — (command_id, ordinal) 둘 다 NULL 이거나, 둘 다 non-NULL 이고 ordinal IN (1,2).
  -- 부분 NULL 이나 범위 밖 ordinal 을 방지한다.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ssg_issue_log'
       AND CONSTRAINT_NAME = 'ck_ssg_issue_log_ordinal'
       AND CONSTRAINT_TYPE = 'CHECK'
  ) THEN
    ALTER TABLE `ssg_issue_log`
      ADD CONSTRAINT `ck_ssg_issue_log_ordinal` CHECK (
        (`pin_issue_command_id` IS NULL AND `issue_ordinal` IS NULL)
        OR (`pin_issue_command_id` IS NOT NULL AND `issue_ordinal` IS NOT NULL AND `issue_ordinal` IN (1, 2))
      );
  END IF;
END //
DELIMITER ;

CALL `p30_p1_alter_ssg_issue_log_constraints`();
DROP PROCEDURE IF EXISTS `p30_p1_alter_ssg_issue_log_constraints`;

-- ssg_issue_log_ops_archive — 수동 복구 시 DELETE 된 PIN 블랙리스트 보존용.
-- 상용에 이미 4행 존재. dev/test 에는 테이블이 없을 수 있으므로 CREATE IF NOT EXISTS.
-- P1 dedup 쿼리가 UNION 으로 참조한다. tombstone 전환 후 신규 유입 없음.
CREATE TABLE IF NOT EXISTS `ssg_issue_log_ops_archive` (
  `id` INT NOT NULL,
  `bar_code` VARCHAR(32) NOT NULL,
  `personal_code` VARCHAR(32) NOT NULL,
  `order_delivery_id` INT NOT NULL,
  `ssg_transaction_id` VARCHAR(64) NOT NULL,
  `event_no` VARCHAR(32) NOT NULL,
  `event_seq` INT NULL,
  `ssg_event_id` INT NULL,
  `inserted_at` DATETIME(6) NOT NULL,
  `expire_at` DATETIME NULL,
  `encourage_at` DATETIME NULL,
  `coupon_num` VARCHAR(100) NULL,
  `archived_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_archive_bar_code` (`bar_code`),
  UNIQUE KEY `uq_archive_personal_code` (`personal_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='수동 복구 시 DELETE 된 ssg_issue_log 행 보존 (PIN 블랙리스트)';

-- 운영에 이미 존재하는 archive 테이블 스키마 검증.
-- P1 dedup UNION 이 bar_code/personal_code/order_delivery_id 컬럼과 unique index 를 전제한다.
-- 컬럼 타입·nullability·인덱스 구조를 개별 검증하여 silent 스키마 불일치를 방지한다.
DROP PROCEDURE IF EXISTS `p30_p1_verify_archive_schema`;
DELIMITER $$
CREATE PROCEDURE `p30_p1_verify_archive_schema`()
BEGIN
  DECLARE v_ok INT DEFAULT 0;

  -- bar_code: varchar(32) NOT NULL
  SELECT COUNT(*) INTO v_ok
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ssg_issue_log_ops_archive'
     AND COLUMN_NAME = 'bar_code'
     AND COLUMN_TYPE = 'varchar(32)'
     AND IS_NULLABLE = 'NO';
  IF v_ok <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ssg_issue_log_ops_archive: bar_code must be varchar(32) NOT NULL';
  END IF;

  -- personal_code: varchar(32) NOT NULL
  SELECT COUNT(*) INTO v_ok
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ssg_issue_log_ops_archive'
     AND COLUMN_NAME = 'personal_code'
     AND COLUMN_TYPE = 'varchar(32)'
     AND IS_NULLABLE = 'NO';
  IF v_ok <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ssg_issue_log_ops_archive: personal_code must be varchar(32) NOT NULL';
  END IF;

  -- order_delivery_id: int NOT NULL
  SELECT COUNT(*) INTO v_ok
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ssg_issue_log_ops_archive'
     AND COLUMN_NAME = 'order_delivery_id'
     AND COLUMN_TYPE = 'int'
     AND IS_NULLABLE = 'NO';
  IF v_ok <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ssg_issue_log_ops_archive: order_delivery_id must be int NOT NULL';
  END IF;

  -- uq_archive_bar_code: single-column unique on bar_code
  SELECT COUNT(*) INTO v_ok
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ssg_issue_log_ops_archive'
     AND INDEX_NAME = 'uq_archive_bar_code'
     AND NON_UNIQUE = 0
     AND COLUMN_NAME = 'bar_code'
     AND SEQ_IN_INDEX = 1
     AND SUB_PART IS NULL;
  IF v_ok <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ssg_issue_log_ops_archive: uq_archive_bar_code must be single-column unique on bar_code';
  END IF;
  -- ensure it is truly single-column (no extra columns in the index)
  SELECT COUNT(*) INTO v_ok
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ssg_issue_log_ops_archive'
     AND INDEX_NAME = 'uq_archive_bar_code';
  IF v_ok <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ssg_issue_log_ops_archive: uq_archive_bar_code must be single-column (composite detected)';
  END IF;

  -- uq_archive_personal_code: single-column unique on personal_code
  SELECT COUNT(*) INTO v_ok
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ssg_issue_log_ops_archive'
     AND INDEX_NAME = 'uq_archive_personal_code'
     AND NON_UNIQUE = 0
     AND COLUMN_NAME = 'personal_code'
     AND SEQ_IN_INDEX = 1
     AND SUB_PART IS NULL;
  IF v_ok <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ssg_issue_log_ops_archive: uq_archive_personal_code must be single-column unique on personal_code';
  END IF;
  SELECT COUNT(*) INTO v_ok
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ssg_issue_log_ops_archive'
     AND INDEX_NAME = 'uq_archive_personal_code';
  IF v_ok <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ssg_issue_log_ops_archive: uq_archive_personal_code must be single-column (composite detected)';
  END IF;
END$$
DELIMITER ;

CALL `p30_p1_verify_archive_schema`();
DROP PROCEDURE IF EXISTS `p30_p1_verify_archive_schema`;
