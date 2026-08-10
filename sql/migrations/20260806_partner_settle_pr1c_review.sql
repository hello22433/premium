-- PR1C: review·orphan resolution schema
-- 정본 §5.11, §5.13, §5.14, §5.15.1, §5.15.5

-- 1) partner_settle_review_resolution (§5.11)
CREATE TABLE IF NOT EXISTS `partner_settle_review_resolution` (
  `id`                   INT            NOT NULL AUTO_INCREMENT,
  `ledger_id`            INT            NOT NULL COMMENT 'FK) partner_settle_ledger.id',
  `review_code`          VARCHAR(32)    NOT NULL COMMENT 'propose 시점 ledger reviewCode 스냅샷',
  `resolution_mode`      VARCHAR(16)    NOT NULL COMMENT 'SET_TIME|SET_PRICE|SET_UNKNOWN|RECLASSIFY|DISCARD',
  `proposed_values`      JSON           NULL     COMMENT '모드별 확정값',
  `evidence_ref`         VARCHAR(1000)  NULL     COMMENT '증적 참조',
  `evidence_hash`        VARCHAR(128)   NULL     COMMENT '증적 정규화 hash',
  `request_key`          VARCHAR(255)   NOT NULL,
  `payload_hash`         VARCHAR(128)   NOT NULL,
  `payload_hash_version` VARCHAR(8)     NOT NULL DEFAULT 'v1',
  `status`               VARCHAR(16)    NOT NULL COMMENT 'PENDING|APPROVED|REJECTED',
  `proposed_by`          INT            NOT NULL,
  `proposed_at`          DATETIME(6)    NOT NULL,
  `decided_by`           INT            NULL,
  `decided_at`           DATETIME(6)    NULL,
  `decision_reason`      VARCHAR(1000)  NULL,
  `active_pending_key`   INT            GENERATED ALWAYS AS (CASE WHEN `status` = 'PENDING' THEN `ledger_id` END) STORED,
  `created_at`           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_review_resolution_request_key` (`request_key`),
  UNIQUE KEY `uq_review_resolution_active_pending` (`ledger_id`, `active_pending_key`),
  INDEX `idx_review_resolution_ledger` (`ledger_id`),
  CONSTRAINT `fk_review_resolution_ledger`
    FOREIGN KEY (`ledger_id`) REFERENCES `partner_settle_ledger` (`id`),
  CHECK (`status` IN ('PENDING', 'APPROVED', 'REJECTED')),
  CHECK (`resolution_mode` IN ('SET_TIME', 'SET_PRICE', 'SET_UNKNOWN', 'RECLASSIFY', 'DISCARD')),
  CHECK ((`decided_by` IS NULL) = (`decided_at` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) partner_provider_manual_event_proposal (§5.13)
CREATE TABLE IF NOT EXISTS `partner_provider_manual_event_proposal` (
  `id`                   INT            NOT NULL AUTO_INCREMENT,
  `provider`             VARCHAR(24)    NOT NULL,
  `order_delivery_id`    INT            NOT NULL,
  `source_type`          VARCHAR(16)    NOT NULL,
  `proposed_payload`     JSON           NOT NULL,
  `payload_fingerprint`  VARCHAR(128)   NOT NULL,
  `observed_status`      VARCHAR(64)    NOT NULL,
  `evidence_ref`         VARCHAR(1000)  NOT NULL,
  `evidence_hash`        VARCHAR(128)   NOT NULL,
  `proposed_by`          INT            NOT NULL,
  `request_key`          VARCHAR(255)   NOT NULL,
  `payload_hash`         VARCHAR(128)   NOT NULL,
  `payload_hash_version` VARCHAR(8)     NOT NULL DEFAULT 'v1',
  `status`               VARCHAR(16)    NOT NULL COMMENT 'PENDING|APPROVED|REJECTED',
  `active_pending_key`   VARCHAR(128)   GENERATED ALWAYS AS (
    CASE WHEN `status` = 'PENDING'
      THEN CONCAT(`provider`, ':', `order_delivery_id`, ':', `source_type`)
    END
  ) STORED,
  `decided_by`           INT            NULL,
  `decided_at`           DATETIME(6)    NULL,
  `decision_reason`      VARCHAR(1000)  NULL,
  `inbox_row_id`         INT            NULL     COMMENT '승인 시 생성된 MANUAL inbox row',
  `created_at`           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_manual_event_proposal_request_key` (`request_key`),
  UNIQUE KEY `uq_manual_event_proposal_active_pending` (`active_pending_key`),
  -- 양방향: proposal.inbox_row_id=X 이면 inbox(X).manual_proposal_id=proposal.id 를 DB 가 강제
  CONSTRAINT `fk_manual_event_proposal_inbox_bidir`
    FOREIGN KEY (`inbox_row_id`, `id`) REFERENCES `partner_provider_event_inbox` (`id`, `manual_proposal_id`),
  CHECK (`status` IN ('PENDING', 'APPROVED', 'REJECTED')),
  CHECK ((`status` = 'APPROVED') = (`inbox_row_id` IS NOT NULL)),
  CHECK ((`decided_by` IS NULL) = (`decided_at` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) partner_provider_manual_ledger_proposal (§5.14)
CREATE TABLE IF NOT EXISTS `partner_provider_manual_ledger_proposal` (
  `id`                      INT            NOT NULL AUTO_INCREMENT,
  `provider`                VARCHAR(24)    NOT NULL,
  `order_delivery_id`       INT            NOT NULL,
  `source_type`             VARCHAR(16)    NOT NULL COMMENT '서버 도출 (요청 body 포함 시 400)',
  `inbox_row_id`            INT            NOT NULL COMMENT 'FK) orphan lane inbox row',
  `source_evidence_payload` JSON           NOT NULL COMMENT 'inbox normalizedPayload 스냅샷',
  `proposed_ledger_facts`   JSON           NULL     COMMENT 'LEDGER면 NOT NULL, DISCARD면 NULL',
  `resolution_mode`         VARCHAR(16)    NOT NULL COMMENT 'LEDGER|DISCARD',
  `evidence_ref`            VARCHAR(1000)  NOT NULL,
  `evidence_hash`           VARCHAR(128)   NOT NULL,
  `reason`                  VARCHAR(500)   NOT NULL,
  `proposed_by`             INT            NOT NULL,
  `request_key`             VARCHAR(255)   NOT NULL,
  `payload_hash`            VARCHAR(128)   NOT NULL,
  `payload_hash_version`    VARCHAR(8)     NOT NULL DEFAULT 'v1',
  `assertion_hash`          VARCHAR(128)   NOT NULL COMMENT '{provider,orderDeliveryId,sourceType,inboxRowId}',
  `status`                  VARCHAR(16)    NOT NULL COMMENT 'PENDING|APPROVED|REJECTED',
  `active_pending_key`      VARCHAR(128)   GENERATED ALWAYS AS (
    CASE WHEN `status` = 'PENDING' THEN `assertion_hash` END
  ) STORED,
  `approved_assertion_key`  VARCHAR(128)   GENERATED ALWAYS AS (
    CASE WHEN `status` = 'APPROVED' THEN `assertion_hash` END
  ) STORED,
  `approved_inbox_binding`  INT            GENERATED ALWAYS AS (
    CASE WHEN `status` = 'APPROVED' THEN `inbox_row_id` END
  ) STORED,
  `decided_by`              INT            NULL,
  `decided_at`              DATETIME(6)    NULL,
  `decision_reason`         VARCHAR(1000)  NULL,
  `created_at`              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_manual_ledger_proposal_request_key` (`request_key`),
  UNIQUE KEY `uq_manual_ledger_proposal_active_pending` (`active_pending_key`),
  UNIQUE KEY `uq_manual_ledger_proposal_approved_assertion` (`approved_assertion_key`),
  -- 단방향 참조 무결성 (inbox 존재 보장)
  CONSTRAINT `fk_manual_ledger_proposal_inbox`
    FOREIGN KEY (`inbox_row_id`) REFERENCES `partner_provider_event_inbox` (`id`),
  -- 양방향: APPROVED 시 inbox(X).manual_ledger_proposal_id=proposal.id 를 DB 가 강제
  CONSTRAINT `fk_manual_ledger_proposal_inbox_bidir`
    FOREIGN KEY (`approved_inbox_binding`, `id`) REFERENCES `partner_provider_event_inbox` (`id`, `manual_ledger_proposal_id`),
  CHECK (`status` IN ('PENDING', 'APPROVED', 'REJECTED')),
  CHECK (`resolution_mode` IN ('LEDGER', 'DISCARD')),
  CHECK ((`resolution_mode` = 'LEDGER') = (`proposed_ledger_facts` IS NOT NULL)),
  CHECK ((`decided_by` IS NULL) = (`decided_at` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4) partner_settle_review_audit (§5.15.5)
--    review_resolution·manual_ledger_proposal 이 먼저 존재해야 FK 가 걸린다.
CREATE TABLE IF NOT EXISTS `partner_settle_review_audit` (
  `id`                              INT            NOT NULL AUTO_INCREMENT,
  `ledger_id`                       INT            NULL     COMMENT '§5.11 ledger review 감사면 NOT NULL',
  `manual_ledger_proposal_id`       INT            NULL     COMMENT '§5.14 orphan 감사면 NOT NULL',
  `before_status`                   VARCHAR(16)    NULL,
  `after_status`                    VARCHAR(16)    NULL,
  `before_review_code`              VARCHAR(32)    NULL,
  `after_review_code`               VARCHAR(32)    NULL,
  `before_review_resolution`        VARCHAR(16)    NULL,
  `after_review_resolution`         VARCHAR(16)    NULL,
  `before_occurred_at`              DATETIME(6)    NULL,
  `after_occurred_at`               DATETIME(6)    NULL,
  `before_base_amount`              BIGINT         NULL,
  `after_base_amount`               BIGINT         NULL,
  `before_applied_price_percent`    DECIMAL(7,4)   NULL,
  `after_applied_price_percent`     DECIMAL(7,4)   NULL,
  `before_applied_price_adjustment` VARCHAR(16)    NULL,
  `after_applied_price_adjustment`  VARCHAR(16)    NULL,
  `before_settle_amount`            BIGINT         NULL,
  `after_settle_amount`             BIGINT         NULL,
  `before_pricing_resolution`       VARCHAR(24)    NULL,
  `after_pricing_resolution`        VARCHAR(24)    NULL,
  `provider_evidence_ref`           VARCHAR(1000)  NULL,
  `provider_evidence_hash`          VARCHAR(128)   NULL,
  `price_evidence_ref`              VARCHAR(1000)  NULL,
  `resolution_id`                   INT            NULL     COMMENT 'FK) partner_settle_review_resolution.id',
  `actor_id`                        INT            NOT NULL,
  `reason`                          VARCHAR(1000)  NULL,
  `created_at`                      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  INDEX `idx_review_audit_ledger` (`ledger_id`, `created_at`),
  INDEX `idx_review_audit_proposal` (`manual_ledger_proposal_id`, `created_at`),
  INDEX `idx_review_audit_resolution` (`resolution_id`),
  CONSTRAINT `fk_review_audit_ledger`
    FOREIGN KEY (`ledger_id`) REFERENCES `partner_settle_ledger` (`id`),
  CONSTRAINT `fk_review_audit_proposal`
    FOREIGN KEY (`manual_ledger_proposal_id`) REFERENCES `partner_provider_manual_ledger_proposal` (`id`),
  CONSTRAINT `fk_review_audit_resolution`
    FOREIGN KEY (`resolution_id`) REFERENCES `partner_settle_review_resolution` (`id`),
  CHECK ((`ledger_id` IS NULL) <> (`manual_ledger_proposal_id` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5) partner_settle_transition_resolution (§5.15.1)
CREATE TABLE IF NOT EXISTS `partner_settle_transition_resolution` (
  `id`                       INT            NOT NULL AUTO_INCREMENT,
  `observation_id`           INT            NOT NULL COMMENT 'FK) partner_settle_transition_observation.id',
  `proposed_transitions`     JSON           NOT NULL,
  `resolution_bundle_hash`   VARCHAR(128)   NOT NULL,
  `request_key`              VARCHAR(255)   NOT NULL,
  `payload_hash`             VARCHAR(128)   NOT NULL,
  `payload_hash_version`     VARCHAR(8)     NOT NULL DEFAULT 'v1',
  `status`                   VARCHAR(16)    NOT NULL COMMENT 'PENDING|APPROVED|REJECTED',
  `proposed_by`              INT            NOT NULL,
  `decided_by`               INT            NULL,
  `decided_at`               DATETIME(6)    NULL,
  `decision_reason`          VARCHAR(1000)  NULL,
  `active_pending_key`       INT            GENERATED ALWAYS AS (
    CASE WHEN `status` = 'PENDING' THEN `observation_id` END
  ) STORED,
  `created_at`               DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`               DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_transition_resolution_request_key` (`request_key`),
  UNIQUE KEY `uq_transition_resolution_active_pending` (`observation_id`, `active_pending_key`),
  INDEX `idx_transition_resolution_observation` (`observation_id`),
  CONSTRAINT `fk_transition_resolution_observation`
    FOREIGN KEY (`observation_id`) REFERENCES `partner_settle_transition_observation` (`id`),
  CHECK (`status` IN ('PENDING', 'APPROVED', 'REJECTED')),
  CHECK ((`decided_by` IS NULL) = (`decided_at` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6) ledger FK 추가 (PR1B placeholder 컬럼)
-- S5: 하나의 복원 전이가 여러 역분개 allocation 을 가질 수 있다.
-- 기존 전이 row 는 모두 단일 allocation 이므로 명시적으로 1을 backfill 한다. DEFAULT 는 이후 producer 누락을 숨긴다.
ALTER TABLE `partner_settle_ledger`
  ADD COLUMN `transition_allocation_no` INT NULL COMMENT '같은 전이 내 역분개 allocation 순번 (1..N)' AFTER `transition_sequence_no`;

UPDATE `partner_settle_ledger`
SET `transition_allocation_no` = 1
WHERE `transition_observation_id` IS NOT NULL;

ALTER TABLE `partner_settle_ledger`
  DROP INDEX `uk_partner_settle_ledger_transition`,
  ADD UNIQUE KEY `uk_partner_settle_ledger_transition`
    (`transition_observation_id`, `transition_sequence_no`, `transition_allocation_no`),
  DROP CHECK `chk_partner_settle_ledger_transition_pair`,
  ADD CONSTRAINT `chk_partner_settle_ledger_transition_pair`
    CHECK (
      (`transition_observation_id` IS NULL
        AND `transition_sequence_no` IS NULL
        AND `transition_allocation_no` IS NULL
        AND `source_event_id_origin` IS NULL)
      OR
      (`transition_observation_id` IS NOT NULL
        AND `transition_sequence_no` IS NOT NULL
        AND `transition_allocation_no` IS NOT NULL
        AND `transition_allocation_no` > 0
        AND `source_event_id_origin` IS NOT NULL)
    );
ALTER TABLE `partner_settle_ledger`
  ADD INDEX `idx_ledger_review_resolution` (`review_resolution_id`),
  ADD INDEX `idx_ledger_manual_ledger_proposal` (`manual_ledger_proposal_id`),
  ADD CONSTRAINT `fk_ledger_review_resolution`
    FOREIGN KEY (`review_resolution_id`) REFERENCES `partner_settle_review_resolution` (`id`),
  ADD CONSTRAINT `fk_ledger_manual_ledger_proposal`
    FOREIGN KEY (`manual_ledger_proposal_id`) REFERENCES `partner_provider_manual_ledger_proposal` (`id`);

-- 7) inbox → proposal 역방향 FK (양방향 무결성 완성)
--    proposal 테이블이 먼저 존재해야 하므로 ALTER 로 후행 추가.
ALTER TABLE `partner_provider_event_inbox`
  ADD CONSTRAINT `fk_inbox_manual_event_proposal`
    FOREIGN KEY (`manual_proposal_id`) REFERENCES `partner_provider_manual_event_proposal` (`id`),
  ADD CONSTRAINT `fk_inbox_manual_ledger_proposal`
    FOREIGN KEY (`manual_ledger_proposal_id`) REFERENCES `partner_provider_manual_ledger_proposal` (`id`);
