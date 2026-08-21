-- EP-P30 P2: 조회 대기 lifecycle (§6-B, §6-C, §7-2, §7-3)
-- not_issued_streak: 연속 tryYn='N' 관측 카운터 (§5-4, streak CAS)
-- resolution_deadline_at: 최초 resolver 진입 시 1회 저장, 이후 불변 (§7-3)
--
-- 멱등: 각 컬럼을 information_schema 로 개별 guard + 기존 컬럼 정의 검증.
-- MySQL 8.0.16+ 필수 (P1 CHECK 제약과 동일 최소 버전).
-- 오류 중단 클라이언트로 실행할 것.

DROP PROCEDURE IF EXISTS `p30_p2_add_streak_deadline_columns`;

DELIMITER //
CREATE PROCEDURE `p30_p2_add_streak_deadline_columns`()
BEGIN
  DECLARE mysql_major INT;
  DECLARE mysql_minor INT;
  DECLARE mysql_patch INT;
  DECLARE col_type VARCHAR(64);
  DECLARE col_nullable VARCHAR(3);
  DECLARE col_default VARCHAR(64);
  DECLARE col_precision INT;

  SET mysql_major = CAST(SUBSTRING_INDEX(@@version, '.', 1) AS UNSIGNED);
  SET mysql_minor = CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(@@version, '.', 2), '.', -1) AS UNSIGNED);
  SET mysql_patch = CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(@@version, '.', 3), '-', 1), '.', -1) AS UNSIGNED);

  IF mysql_major < 8 OR (mysql_major = 8 AND mysql_minor = 0 AND mysql_patch < 16) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'EP-P30 P2: MySQL >= 8.0.16 필수. 현재 버전이 미달합니다.';
  END IF;

  -- not_issued_streak
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'not_issued_streak'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `not_issued_streak` SMALLINT NOT NULL DEFAULT 0
        COMMENT '연속 tryYn=N 관측 횟수 (§5-4, streak CAS)';
  ELSE
    SELECT DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
      INTO col_type, col_nullable, col_default
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'not_issued_streak';
    IF col_type != 'smallint' OR col_nullable != 'NO' OR NOT (col_default <=> '0') THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'EP-P30 P2: not_issued_streak 컬럼이 존재하나 정의 불일치 (expected SMALLINT NOT NULL DEFAULT 0).';
    END IF;
  END IF;

  -- resolution_deadline_at
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'resolution_deadline_at'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `resolution_deadline_at` DATETIME(6) NULL
        COMMENT 'resolver 최초 진입 시 1회 저장, 이후 불변 — 만료 시 OPS_REVIEW_REQUIRED (§7-3)';
  ELSE
    SELECT DATA_TYPE, IS_NULLABLE, DATETIME_PRECISION, COLUMN_DEFAULT
      INTO col_type, col_nullable, col_precision, col_default
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'resolution_deadline_at';
    IF col_type != 'datetime' OR col_nullable != 'YES' OR col_precision != 6 OR col_default IS NOT NULL THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'EP-P30 P2: resolution_deadline_at 컬럼이 존재하나 정의 불일치 (expected DATETIME(6) NULL DEFAULT NULL).';
    END IF;
  END IF;
END //
DELIMITER ;

CALL `p30_p2_add_streak_deadline_columns`();
DROP PROCEDURE IF EXISTS `p30_p2_add_streak_deadline_columns`;
