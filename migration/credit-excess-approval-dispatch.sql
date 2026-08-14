-- ============================================================================
-- [EP-P23] 신용초과 승인 = 서버 발송확정 실행
--
-- 배포 순서
--   1) 본 SQL 적용 (기존 활성 요청 일괄 종료 포함)
--   2) 애플리케이션 배포
--   ※ 역순 배포 금지 — 신규 코드는 attempt_token/snapshot 컬럼을 필수로 읽는다.
--
-- 롤백
--   - 애플리케이션 롤백 후 아래 "ROLLBACK" 블록 실행.
--   - 종료 처리된 기존 요청은 복원하지 않는다 (스냅샷 없는 요청의 자동 발송 금지).
-- ============================================================================

-- ── 1. credit_excess_approval 확장 ──────────────────────────────────────────
ALTER TABLE `credit_excess_approval`
  MODIFY COLUMN `status` VARCHAR(24) NOT NULL DEFAULT 'PENDING'
    COMMENT 'PENDING | PROCESSING | COMPLETED | FAILED | RE_REQUEST_REQUIRED | REJECTED | EXPIRED',
  MODIFY COLUMN `wallet_account_id` BIGINT NULL COMMENT 'LEGACY 모드 등 wallet 미해석 시 NULL',
  MODIFY COLUMN `requested_amount` INT NOT NULL COMMENT '요청 시점 서버 계산 청구 금액',
  MODIFY COLUMN `requested_credit_excess_amount` INT NOT NULL COMMENT '요청 시점 서버 계산 신용초과액',
  MODIFY COLUMN `reason_text` VARCHAR(200) NOT NULL COMMENT '요청 사유 (필수)',
  ADD COLUMN `attempt_token` VARCHAR(64) NULL COMMENT 'PROCESSING 선점 토큰 (fencing)',
  ADD COLUMN `attempt_count` INT NOT NULL DEFAULT 0 COMMENT 'PROCESSING 선점 횟수',
  ADD COLUMN `lease_expires_at` DATETIME(6) NULL COMMENT 'PROCESSING lease 만료 시각',
  ADD COLUMN `processing_started_at` DATETIME(6) NULL,
  ADD COLUMN `finished_at` DATETIME(6) NULL COMMENT '종료 상태 확정 시각',
  ADD COLUMN `diagnostic_code` VARCHAR(64) NULL COMMENT '운영 진단 코드',
  ADD COLUMN `user_message` VARCHAR(300) NULL COMMENT '요청자 노출 메시지',
  ADD COLUMN `changed_fields` JSON NULL COMMENT '변경된 항목명 목록',
  ADD COLUMN `internal_reason` VARCHAR(500) NULL COMMENT '내부 원인 (운영자 전용)',
  ADD COLUMN `snapshot_version` INT NULL COMMENT '스냅샷 schema version',
  ADD COLUMN `snapshot` JSON NULL COMMENT 'PII 최소화 주문/분배 스냅샷';

-- ── 2. 기존 활성 요청 일괄 종료 (생성 컬럼 추가 전에 수행) ──────────────────
--   스냅샷이 없는 과거 요청은 새 승인 흐름으로 자동 실행하지 않는다.
UPDATE `credit_excess_approval`
   SET `status` = 'EXPIRED',
       `finished_at` = NOW(6),
       `diagnostic_code` = 'LEGACY_FLOW_TERMINATED',
       `user_message` = '승인 방식이 변경되어 기존 요청은 종료되었습니다. 발송확정부터 다시 요청해 주세요.',
       `internal_reason` = 'EP-P23 migration: terminated pre-dispatch approval'
 WHERE `status` = 'PENDING'
    OR (`status` = 'APPROVED' AND `consumed_at` IS NULL);

-- ── 3. 활성 요청 unique key (생성 컬럼) ─────────────────────────────────────
ALTER TABLE `credit_excess_approval`
  ADD COLUMN `active_order_key` INT
    GENERATED ALWAYS AS (CASE WHEN `status` IN ('PENDING','PROCESSING') THEN `order_id` ELSE NULL END) STORED
    COMMENT '활성 요청 unique key (생성 컬럼)',
  ADD UNIQUE INDEX `uq_credit_excess_active_order` (`active_order_key`),
  ADD INDEX `idx_credit_excess_lease` (`status`, `lease_expires_at`);

-- 기존 consumed unique 제약은 (id, consumed_at) 으로 PK 와 중복이라 실행 표식으로 대체한다.
ALTER TABLE `credit_excess_approval` DROP INDEX `uq_credit_excess_consumed`;

-- ── 4. 실행 표식 테이블 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `credit_excess_approval_execution` (
  `id`             BIGINT      NOT NULL AUTO_INCREMENT,
  `approval_id`    BIGINT      NOT NULL COMMENT 'credit_excess_approval.id (1:1)',
  `order_id`       INT         NOT NULL,
  `attempt_token`  VARCHAR(64) NOT NULL COMMENT '기록 시점 approval.attempt_token',
  `lifecycle_mode` VARCHAR(20) NOT NULL COMMENT '실행 시점 WALLET_PR2_DELIVERY_LIFECYCLE_MODE',
  `created_at`     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_credit_excess_execution_approval` (`approval_id`),
  KEY `idx_credit_excess_execution_order` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='신용초과 승인 발송확정 실행 표식';

-- ── 검증 ───────────────────────────────────────────────────────────────────
-- SELECT status, COUNT(*) FROM credit_excess_approval GROUP BY status;
-- SELECT COUNT(*) FROM credit_excess_approval WHERE status IN ('PENDING','PROCESSING');  -- 배포 직후 0
-- SHOW CREATE TABLE credit_excess_approval_execution;

-- ============================================================================
-- ROLLBACK (스키마 되돌림 전 데이터 정규화 필수)
--
--   정방향은 wallet_account_id 를 NULL 허용으로 바꾸고, LEGACY/SHADOW 요청은 실제로
--   wallet_account_id = NULL 을 저장한다. 또 PROCESSING/RE_REQUEST_REQUIRED/FAILED/EXPIRED/
--   COMPLETED 같은 신규 상태값을 저장한다. 따라서 아래를 그냥 실행하면
--     (a) `MODIFY wallet_account_id BIGINT NOT NULL` 이 NULL 행에서 실패하고,
--     (b) 레거시 앱이 모르는 상태값이 남아 오동작한다.
--   반드시 1) → 2) → 3) → 4) 순서로 실행하고, 각 단계 검증 SELECT 로 0 을 확인한 뒤 진행한다.
--
--   ※ wallet_account_id 는 NULL 허용을 **그대로 유지한다**. 컷오버 이후 LEGACY/SHADOW 요청은
--     본래 wallet 이 없으므로 NOT NULL 복원은 의미상 틀리고 반드시 실패한다. NULL 허용은 더
--     느슨한 제약이라 레거시 코드에도 안전하다 (가짜 sentinel wallet id 주입 금지).

-- 1) 신규 흐름 상태 정규화 — 레거시가 자동 실행/오해하지 않도록 레거시 상태 모델로 수렴.
--    (a) 발송확정 트랜잭션이 이미 커밋된 행 → APPROVED. 판정 근거는 실행 표식 존재 또는
--        consumed_at IS NOT NULL 이다. finalizeCompleted() 직전에 중단돼 status 가 아직
--        PROCESSING 인 행(consumed_at IS NOT NULL + 실행 표식 존재)도 여기서 수렴시켜야
--        레거시에 모르는 PROCESSING 이 남지 않는다. 2) 에서 실행 표식 테이블을 지우기 전에 먼저 실행한다.
--    (b) 실행되지 않은 나머지 신규 상태 → REJECTED.
-- UPDATE `credit_excess_approval` a
--    SET a.`status` = 'APPROVED'
--  WHERE a.`status` IN ('PENDING','PROCESSING','COMPLETED','FAILED','RE_REQUEST_REQUIRED','EXPIRED')
--    AND (
--         a.`consumed_at` IS NOT NULL
--      OR EXISTS (SELECT 1 FROM `credit_excess_approval_execution` e WHERE e.`approval_id` = a.`id`)
--    );
-- UPDATE `credit_excess_approval`
--    SET `status` = 'REJECTED',
--        `reject_reason` = COALESCE(`reject_reason`, 'EP-P23 rollback: dispatch flow reverted')
--  WHERE `status` IN ('PENDING','PROCESSING','RE_REQUEST_REQUIRED','FAILED','EXPIRED');
--   검증: SELECT status, COUNT(*) FROM credit_excess_approval GROUP BY status;
--         -- PENDING/PROCESSING/COMPLETED/FAILED/RE_REQUEST_REQUIRED/EXPIRED 가 0 이어야 한다.

-- 2) 실행 표식 제거
-- DROP TABLE IF EXISTS `credit_excess_approval_execution`;

-- 3) 생성 컬럼·인덱스·신규 컬럼 제거 (wallet_account_id 는 NULL 허용 유지 — NOT NULL 복원 안 함)
-- ALTER TABLE `credit_excess_approval`
--   DROP INDEX `uq_credit_excess_active_order`,
--   DROP INDEX `idx_credit_excess_lease`,
--   DROP COLUMN `active_order_key`,
--   DROP COLUMN `snapshot`,
--   DROP COLUMN `snapshot_version`,
--   DROP COLUMN `internal_reason`,
--   DROP COLUMN `changed_fields`,
--   DROP COLUMN `user_message`,
--   DROP COLUMN `diagnostic_code`,
--   DROP COLUMN `finished_at`,
--   DROP COLUMN `processing_started_at`,
--   DROP COLUMN `lease_expires_at`,
--   DROP COLUMN `attempt_count`,
--   DROP COLUMN `attempt_token`;

-- 4) 기존 consumed unique 복원 (상태 정규화 이후에만 안전)
--    검증: SELECT COUNT(*) FROM credit_excess_approval WHERE wallet_account_id IS NULL;  -- 참고(허용)
-- ALTER TABLE `credit_excess_approval`
--   ADD UNIQUE INDEX `uq_credit_excess_consumed` (`id`, `consumed_at`);
