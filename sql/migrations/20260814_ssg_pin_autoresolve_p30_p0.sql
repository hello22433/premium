-- EP-P30 P0 — SSG PIN 발급 실패 자동 판정 기반 스키마.
--
-- 이 단계는 **nullable 컬럼 추가 + 관측 테이블 신설**만 한다. 쓰기가 시작된 뒤에만 의미가 있는
-- UNIQUE/CHECK 제약(uq_ssg_issue_log_cmd_ordinal, ck_ssg_issue_log_ordinal)은 P1 migration 소관이다.
-- 컬럼 자체는 nullable 추가라 롤링 배포 중에도 무해하다.
--
-- P0 판정기가 `ssg_issue_log.superseded_at` 을 읽으므로 **코드 배포 전에** 적용해야 한다.
-- MySQL 8.x. 오류 중단 클라이언트로 실행할 것.

DROP PROCEDURE IF EXISTS `p30_p0_alter_ssg_pin_autoresolve`;

DELIMITER //
CREATE PROCEDURE `p30_p0_alter_ssg_pin_autoresolve`()
BEGIN
  -- ssg_issue_log — 발급 차수 기장(§6-A) + tombstone(§6-D)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ssg_issue_log'
       AND COLUMN_NAME = 'pin_issue_command_id'
  ) THEN
    ALTER TABLE `ssg_issue_log`
      ADD COLUMN `pin_issue_command_id` BIGINT NULL COMMENT 'FK) pin_issue_command.id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ssg_issue_log'
       AND COLUMN_NAME = 'issue_ordinal'
  ) THEN
    ALTER TABLE `ssg_issue_log`
      ADD COLUMN `issue_ordinal` TINYINT NULL COMMENT '발급 차수 1=최초, 2=자동 재발급';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ssg_issue_log'
       AND COLUMN_NAME = 'superseded_at'
  ) THEN
    ALTER TABLE `ssg_issue_log`
      ADD COLUMN `superseded_at` DATETIME(6) NULL COMMENT 'tombstone 시각(운영 복구는 DELETE 대신 표식)';
  END IF;

  -- 활성 후보 조회(§6-D)가 delivery + superseded_at 으로 필터하므로 복합 인덱스로 받는다.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ssg_issue_log'
       AND INDEX_NAME = 'idx_ssg_issue_log_delivery_active'
  ) THEN
    ALTER TABLE `ssg_issue_log`
      ADD INDEX `idx_ssg_issue_log_delivery_active` (`order_delivery_id`, `superseded_at`);
  END IF;

  -- pin_issue_command — drain marker(§9-3). workflow_version 은 가변 fencing 카운터라 쓸 수 없다.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'autoresolve_version'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `autoresolve_version` SMALLINT NULL COMMENT 'P30 autoresolve enrollment marker';
  END IF;
END //
DELIMITER ;

CALL `p30_p0_alter_ssg_pin_autoresolve`();
DROP PROCEDURE `p30_p0_alter_ssg_pin_autoresolve`;

-- 관측 테이블 (§9-3) — observe 모드는 durable state 를 바꾸지 않고 여기에만 쓴다.
-- run UNIQUE(command, bucket) 이 다중 인스턴스 중복 관측을 막는다. observe 는 command/claim 을
-- 건들지 않아 상호배제 장치가 없으므로, 이 제약이 "동일 시점 중복 3행 = 연속 3회 N" 오판의 유일한 방어다.
CREATE TABLE IF NOT EXISTS `ssg_pin_observation_run` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `pin_issue_command_id` BIGINT NOT NULL COMMENT 'FK) pin_issue_command.id',
  `order_delivery_id` INT NOT NULL COMMENT 'FK) order_delivery.id',
  `observation_bucket_at` DATETIME(6) NOT NULL COMMENT '5분 버킷(중복 관측 방지)',
  `aggregate_resolution` VARCHAR(24) NOT NULL COMMENT '집계 판정',
  `mode` VARCHAR(16) NOT NULL COMMENT '관측 시점 SSG_PIN_AUTORESOLVE_MODE',
  `candidate_count` INT NOT NULL COMMENT '기록한 후보 수(완전성 검증용)',
  -- 관측 당시 command 스냅샷. 정상 in-flight 표본(STARTED/count=0 등)을 사후에 걸러내기 위해 필수다.
  `command_status` VARCHAR(24) NOT NULL COMMENT '관측 당시 command status',
  `external_issue_count` INT NOT NULL COMMENT '관측 당시 INSERT 권한 소비 횟수',
  `state_entered_at` DATETIME(6) NULL COMMENT '관측 당시 체류 시작',
  `lease_expires_at` DATETIME(6) NULL COMMENT '관측 당시 lease 만료',
  `observed_at` DATETIME(6) NOT NULL,
  `completed_at` DATETIME(6) NULL COMMENT '저장 완료 표식 — NULL 행은 집계에서 제외',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ssg_pin_observation_run_bucket` (`pin_issue_command_id`, `observation_bucket_at`),
  KEY `idx_ssg_pin_observation_run_delivery` (`order_delivery_id`, `observed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='EP-P30 SSG PIN 판정 관측 실행';

CREATE TABLE IF NOT EXISTS `ssg_pin_observation_candidate` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `run_id` BIGINT NOT NULL COMMENT 'FK) ssg_pin_observation_run.id',
  `ssg_issue_log_id` INT NOT NULL COMMENT 'FK) ssg_issue_log.id',
  `try_yn` VARCHAR(1) NULL COMMENT "GetSsgTry tryYn ('Y'|'N')",
  `result_cd` VARCHAR(8) NULL COMMENT 'GetSsgStatus resultCd',
  `resolution` VARCHAR(24) NOT NULL COMMENT '후보 판정',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ssg_pin_observation_candidate` (`run_id`, `ssg_issue_log_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='EP-P30 SSG PIN 판정 관측 후보';
