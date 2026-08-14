-- P24 SSG unknown-result recovery: pin_issue_command authority and active-command fence.
--
-- Apply this migration before deploying code that reads these columns. Each schema change is
-- guarded by information_schema. The durable marker makes the legacy data backfill a single
-- atomic transaction; reruns never mutate command rows.
-- This migration intentionally does not treat a legacy retry as safe. A legacy command that
-- recorded an external attempt is made non-active and its external issue authority is exhausted.
-- MySQL 8.x / MariaDB 10.x. Run with an error-aborting client so the duplicate gate cannot be ignored.

-- This marker is deliberately separate from application schema history: it records the one
-- irreversible legacy-data cutover, including when this SQL file is run manually.
CREATE TABLE IF NOT EXISTS `pin_issue_command_migration_marker` (
  `migration_key` VARCHAR(128) NOT NULL,
  `applied_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`migration_key`)
) ENGINE=InnoDB COMMENT='PIN issue command one-time migration markers';

DROP PROCEDURE IF EXISTS `p24_alter_pin_issue_command_authority`;

DELIMITER //
CREATE PROCEDURE `p24_alter_pin_issue_command_authority`()
BEGIN
  DECLARE v_legacy_backfill_applied BOOLEAN DEFAULT FALSE;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'external_issue_count'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `external_issue_count` INT NOT NULL DEFAULT 0
        COMMENT '외부 SSG INSERT 실행 권한 소비 횟수(최대 2)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'resolution'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `resolution` VARCHAR(24) NULL
        COMMENT 'CONFIRMED|NOT_ISSUED|PROCESSING|UNKNOWN|MULTIPLE_CONFIRMED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'resolution_lookup_count'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `resolution_lookup_count` INT NOT NULL DEFAULT 0
        COMMENT 'SSG 등록 판정 조회 횟수';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'resolution_started_at'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `resolution_started_at` DATETIME(6) NULL
        COMMENT 'SSG 등록 판정 시작 시각';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'lease_expires_at'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `lease_expires_at` DATETIME(6) NULL
        COMMENT '실행 lease 만료 시각';
  END IF;

  -- These fences already exist on newer installations. Add them for every older path.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'owner_token'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `owner_token` VARCHAR(64) NULL COMMENT 'Level B 실행 lease 소유자';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'delivery_claim_token'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `delivery_claim_token` VARCHAR(32) NULL
        COMMENT '최초 batch delivery claim ISO token(lease owner와 분리)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'generation'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `generation` BIGINT NOT NULL DEFAULT 0 COMMENT 'Level B 세대(3중 fencing)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'workflow_version'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `workflow_version` BIGINT NULL COMMENT '바인딩된 delivery_workflow.workflow_version(3중 fencing)';
  END IF;

  -- Legacy attempt_count is the only evidence of an external issue call. Backfill it exactly
  -- once, atomically with its marker. Inserting the marker first is safe because a failed
  -- transaction rolls it back with the command mutations; a concurrent or later rerun sees the
  -- committed marker and does not rewrite live owner, lease, generation, or count fields.
  START TRANSACTION;
  INSERT IGNORE INTO `pin_issue_command_migration_marker` (
    `migration_key`,
    `applied_at`
  ) VALUES (
    '20260810_p24_authority_legacy_backfill',
    CURRENT_TIMESTAMP(6)
  );
  SET v_legacy_backfill_applied = ROW_COUNT() = 1;

  IF v_legacy_backfill_applied THEN
    -- Do not convert a legacy external attempt into a newly-safe retry: consume its remaining
    -- authority and require resolution. Owner/lease/generation are intentionally untouched.
    UPDATE `pin_issue_command`
       SET `external_issue_count` = GREATEST(COALESCE(`external_issue_count`, 0), 2),
           `resolution` = COALESCE(
             `resolution`,
             CASE WHEN `status` = 'SUCCEEDED' THEN 'CONFIRMED' ELSE 'UNKNOWN' END
           ),
           `status` = CASE
             WHEN `status` IN ('STARTED', 'RETRY_PENDING', 'RETRYING', 'OPS_REVIEW_REQUIRED')
               THEN 'UNKNOWN_DEFERRED'
             ELSE `status`
           END,
           `state_entered_at` = CURRENT_TIMESTAMP(6)
     WHERE (`attempt_count` > 0 OR `status` = 'SUCCEEDED')
       AND (
         `external_issue_count` < 2
         OR `resolution` IS NULL
         OR `status` IN ('STARTED', 'RETRY_PENDING', 'RETRYING', 'OPS_REVIEW_REQUIRED')
       );
    -- crash/lease 회수 대상 확정. lease_expires_at 컬럼은 이번 migration 이 신설하므로 기존 STARTED
    -- 행은 NULL 이다. 코드의 sweep 은 (lease_expires_at IS NULL OR < now) 로 회수하지만, fencing 값을
    -- 갖춘 회수 가능한 행은 즉시 만료 lease 로 초기화해 다음 sweep 주기에서 확정적으로 집히게 한다.
    UPDATE `pin_issue_command`
       SET `lease_expires_at` = TIMESTAMP('1970-01-01 00:00:00.000000'),
           `state_entered_at` = CURRENT_TIMESTAMP(6)
     WHERE `status` = 'STARTED'
       AND `attempt_count` = 0
       AND `lease_expires_at` IS NULL
       AND `owner_token` IS NOT NULL
       AND `workflow_version` IS NOT NULL;

    -- fencing 값이 없는 활성 행은 CAS 로 회수할 수 없다(owner/workflow NULL → claimPinCommand 가 매번
    -- null 반환). 영구 정체 대신 운영검토로 격리하고 남은 외부 발급 권한을 소진한다. 활성 상태를
    -- 유지하므로 unique fence 는 그대로 두어 신규 자동 발급을 막는다.
    UPDATE `pin_issue_command`
       SET `status` = 'OPS_REVIEW_REQUIRED',
           `resolution` = COALESCE(`resolution`, 'UNKNOWN'),
           `external_issue_count` = GREATEST(COALESCE(`external_issue_count`, 0), 2),
           `state_entered_at` = CURRENT_TIMESTAMP(6)
     WHERE `status` IN ('STARTED', 'RETRY_PENDING', 'RETRYING')
       AND (`owner_token` IS NULL OR `workflow_version` IS NULL);
  END IF;
  -- Preserve only canonical ISO claim tokens. UUID and legacy owner strings
  -- are resolver ownership, not delivery claims, and must remain unbound.
  UPDATE `pin_issue_command`
     SET `delivery_claim_token` = `owner_token`
   WHERE `delivery_claim_token` IS NULL
     AND `owner_token` REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$';
  COMMIT;

  -- Fail closed before creating the unique index. Remaining duplicates have no proven safe
  -- authority history, so an operator must resolve them rather than choosing a legacy retry.
  IF EXISTS (
    SELECT 1
      FROM `pin_issue_command`
     WHERE `status` IN ('STARTED', 'RETRY_PENDING', 'RETRYING', 'OPS_REVIEW_REQUIRED')
     GROUP BY `order_delivery_id`
    HAVING COUNT(*) > 1
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'P24 migration blocked: duplicate active pin_issue_command rows require manual resolution';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'active_order_delivery_id'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD COLUMN `active_order_delivery_id` BIGINT
        GENERATED ALWAYS AS (
          CASE WHEN `status` IN ('STARTED','RETRY_PENDING','RETRYING','OPS_REVIEW_REQUIRED')
            THEN `order_delivery_id` ELSE NULL END
        ) STORED
        COMMENT '활성 PIN 명령 단일성 보조(종결 상태는 NULL)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND INDEX_NAME = 'uk_pin_issue_command_active_delivery'
       AND NON_UNIQUE <> 0
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'P24 migration blocked: active delivery index exists but is not unique';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND INDEX_NAME = 'uk_pin_issue_command_active_delivery'
  ) THEN
    ALTER TABLE `pin_issue_command`
      ADD UNIQUE INDEX `uk_pin_issue_command_active_delivery` (`active_order_delivery_id`);
  END IF;

  -- The old PIN_ISSUE-only generated key is obsolete once all active commands share one fence.
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND INDEX_NAME = 'uk_pin_issue_command_initial'
  ) THEN
    ALTER TABLE `pin_issue_command` DROP INDEX `uk_pin_issue_command_initial`;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pin_issue_command'
       AND COLUMN_NAME = 'initial_issue_key'
  ) THEN
    ALTER TABLE `pin_issue_command` DROP COLUMN `initial_issue_key`;
  END IF;
END //
DELIMITER ;

CALL `p24_alter_pin_issue_command_authority`();
DROP PROCEDURE `p24_alter_pin_issue_command_authority`;

-- Verification: every query below must return the stated result.
--   SHOW COLUMNS FROM `pin_issue_command`;
--   SHOW INDEX FROM `pin_issue_command` WHERE Key_name = 'uk_pin_issue_command_active_delivery';
--   SELECT migration_key, applied_at
--     FROM pin_issue_command_migration_marker
--    WHERE migration_key = '20260810_p24_authority_legacy_backfill'; -- exactly 1 row
--   SELECT order_delivery_id, COUNT(*) AS active_count
--     FROM pin_issue_command
--    WHERE status IN ('STARTED','RETRY_PENDING','RETRYING','OPS_REVIEW_REQUIRED')
--    GROUP BY order_delivery_id HAVING COUNT(*) > 1; -- 0 rows
--   SELECT COUNT(*) AS legacy_attempt_with_authority
--     FROM pin_issue_command
--    WHERE attempt_count > 0 AND external_issue_count < 2; -- 0
--
-- Rerun proof (in the same mysql session): snapshot live and authority fields, rerun this entire
-- migration file, then this comparison must return 0 rows. The marker makes the second execution
-- a command-data no-op even when a live worker owns a STARTED/RETRY_PENDING/RETRYING command.
--   CREATE TEMPORARY TABLE p24_rerun_snapshot AS
--   SELECT id, status, owner_token, lease_expires_at, generation,
--          attempt_count, external_issue_count, resolution_lookup_count
--     FROM pin_issue_command;
--   -- Rerun: SOURCE sql/migrations/20260810_add_pin_issue_command_p24_authority.sql;
--   SELECT p.id
--     FROM pin_issue_command p
--     JOIN p24_rerun_snapshot s ON s.id = p.id
--    WHERE NOT (p.status <=> s.status)
--       OR NOT (p.owner_token <=> s.owner_token)
--       OR NOT (p.lease_expires_at <=> s.lease_expires_at)
--       OR NOT (p.generation <=> s.generation)
--       OR NOT (p.attempt_count <=> s.attempt_count)
--       OR NOT (p.external_issue_count <=> s.external_issue_count)
--       OR NOT (p.resolution_lookup_count <=> s.resolution_lookup_count); -- 0 rows

-- Rollback (manual and exceptional): do not run while P24 code is deployed. The old initial
-- unique key cannot be restored until this preflight returns 0 rows, because P24 may retain
-- multiple historical PIN_ISSUE commands for one delivery:
--   SELECT order_delivery_id FROM pin_issue_command WHERE created_by_op = 'PIN_ISSUE'
--    GROUP BY order_delivery_id HAVING COUNT(*) > 1;
-- After that gate is clean:
--   ALTER TABLE pin_issue_command DROP INDEX uk_pin_issue_command_active_delivery;
--   ALTER TABLE pin_issue_command DROP COLUMN active_order_delivery_id;
--   ALTER TABLE pin_issue_command
--     ADD COLUMN initial_issue_key INT GENERATED ALWAYS AS
--       (CASE WHEN created_by_op = 'PIN_ISSUE' THEN order_delivery_id END) STORED,
--     ADD UNIQUE INDEX uk_pin_issue_command_initial (initial_issue_key);
-- P24 authority/resolution columns intentionally remain: deleting their audit state can revive
-- consumed authority and is not a safe rollback.
