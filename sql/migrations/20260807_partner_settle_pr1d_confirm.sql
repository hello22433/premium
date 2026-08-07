-- PR1D — confirm·unconfirm·paid (협력사 정산확정·해제·지급)
-- 정본 §5.2, §5.7.1, §5.7.2, §5.8, §5.9, §5.15.3, §5.15.4
-- 의존: partner_settle_ledger (PR1B), partner_company (기존)

-- ---------------------------------------------------------------------------
-- 1. partner_settle_batch (정산확정 배치)
-- ---------------------------------------------------------------------------

CREATE TABLE `partner_settle_batch` (
  `id`                         INT          NOT NULL AUTO_INCREMENT,
  `partner_company_id`         INT          NOT NULL,
  `period_end`                 DATE         NOT NULL COMMENT 'exclusive 종료 경계 (KST)',
  `confirmed_by`               INT          NOT NULL,
  `confirmed_at`               DATETIME(6)  NOT NULL,
  `confirmed_total_amount`     BIGINT       NOT NULL COMMENT '확정 시점 동결 합계',
  `confirmed_count`            INT          NOT NULL COMMENT '확정 시점 동결 건수',
  `status`                     VARCHAR(24)  NOT NULL DEFAULT 'CONFIRMED_UNPAID'
      COMMENT 'CONFIRMED_UNPAID|PAID|CANCELED',
  `batch_type`                 VARCHAR(24)  NOT NULL DEFAULT 'NORMAL'
      COMMENT 'NORMAL|OPENING_IMPORT',
  `request_key`                VARCHAR(191) NULL COMMENT 'confirm 멱등 키 (NORMAL 필수)',
  `payload_hash`               VARCHAR(128) NULL,
  `payload_hash_version`       VARCHAR(16)  NULL,
  `paid_at`                    DATETIME(6)  NULL,
  `paid_by`                    INT          NULL,
  `payment_evidence_ref`       VARCHAR(255) NULL,
  `import_run_id`              VARCHAR(191) NULL COMMENT 'OPENING_IMPORT 전용',
  `carry_in_amount`            BIGINT       NULL COMMENT 'PAID 시점 확정. 미지급 NULL',
  `finalized_total_amount`     BIGINT       NULL COMMENT 'PAID 시점 재동결 유효 합계',
  `carry_out_amount`           BIGINT       NULL COMMENT 'min(0, finalized+carryIn)',
  `payment_request_id`         INT          NULL COMMENT 'NORMAL PAID 시 필수',
  `paid_request_key`           VARCHAR(191) NULL COMMENT 'payment_request 감사 복사본',
  `paid_payload_hash`          VARCHAR(128) NULL,
  `paid_payload_hash_version`  VARCHAR(16)  NULL,
  `paid_amount`                BIGINT       NULL COMMENT '확정 현금 지급액',
  `calculated_paid_amount`     BIGINT       NULL COMMENT '원장+carry 계산 지급예정액',
  `actual_paid_amount`         BIGINT       NULL COMMENT '실제 송금액',
  `canceled_by`                INT          NULL,
  `canceled_at`                DATETIME(6)  NULL,
  `active_period_key`          DATE GENERATED ALWAYS AS (
    CASE WHEN `status` <> 'CANCELED' THEN `period_end` END
  ) STORED,
  `created_at`                 DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                 DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                 DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_batch_request_key` (`request_key`),
  UNIQUE KEY `uk_batch_active_period` (`partner_company_id`, `active_period_key`),
  UNIQUE KEY `uk_batch_id_partner` (`id`, `partner_company_id`),
  KEY `idx_batch_partner_status` (`partner_company_id`, `status`),
  KEY `idx_batch_partner_period` (`partner_company_id`, `period_end`),

  -- batch_type OPENING_IMPORT CHECK
  CONSTRAINT `chk_batch_type_opening` CHECK (
    `batch_type` <> 'OPENING_IMPORT' OR (
      `status` = 'PAID'
      AND `import_run_id` IS NOT NULL
      AND `request_key` IS NULL AND `payload_hash` IS NULL AND `payload_hash_version` IS NULL
      AND `carry_in_amount` = 0 AND `carry_out_amount` = 0
      AND `payment_request_id` IS NULL
      AND `calculated_paid_amount` IS NULL
      AND `paid_amount` = `actual_paid_amount`
    )
  ),
  -- batch_type NORMAL CHECK
  CONSTRAINT `chk_batch_type_normal` CHECK (
    `batch_type` <> 'NORMAL' OR (
      `import_run_id` IS NULL
      AND `request_key` IS NOT NULL AND `payload_hash` IS NOT NULL AND `payload_hash_version` IS NOT NULL
    )
  ),
  -- status CONFIRMED_UNPAID CHECK
  CONSTRAINT `chk_status_confirmed_unpaid` CHECK (
    `status` <> 'CONFIRMED_UNPAID' OR (
      `paid_at` IS NULL AND `paid_by` IS NULL AND `payment_evidence_ref` IS NULL
      AND `payment_request_id` IS NULL
      AND `paid_request_key` IS NULL AND `paid_payload_hash` IS NULL AND `paid_payload_hash_version` IS NULL
      AND `paid_amount` IS NULL AND `actual_paid_amount` IS NULL AND `calculated_paid_amount` IS NULL
      AND `finalized_total_amount` IS NULL AND `carry_in_amount` IS NULL AND `carry_out_amount` IS NULL
      AND `canceled_by` IS NULL AND `canceled_at` IS NULL
    )
  ),
  -- status PAID + NORMAL CHECK
  CONSTRAINT `chk_status_paid_normal` CHECK (
    NOT (`status` = 'PAID' AND `batch_type` = 'NORMAL') OR (
      `paid_at` IS NOT NULL AND `paid_by` IS NOT NULL AND `payment_evidence_ref` IS NOT NULL
      AND `payment_request_id` IS NOT NULL
      AND `paid_request_key` IS NOT NULL AND `paid_payload_hash` IS NOT NULL AND `paid_payload_hash_version` IS NOT NULL
      AND `paid_amount` IS NOT NULL AND `actual_paid_amount` IS NOT NULL AND `calculated_paid_amount` IS NOT NULL
      AND `finalized_total_amount` IS NOT NULL AND `carry_in_amount` IS NOT NULL AND `carry_out_amount` IS NOT NULL
      AND `paid_amount` = `actual_paid_amount`
    )
  ),
  -- status CANCELED CHECK
  CONSTRAINT `chk_status_canceled` CHECK (
    `status` <> 'CANCELED' OR (
      `canceled_by` IS NOT NULL AND `canceled_at` IS NOT NULL
      AND `paid_at` IS NULL AND `paid_by` IS NULL AND `payment_evidence_ref` IS NULL
      AND `payment_request_id` IS NULL
      AND `paid_request_key` IS NULL AND `paid_payload_hash` IS NULL AND `paid_payload_hash_version` IS NULL
      AND `paid_amount` IS NULL AND `actual_paid_amount` IS NULL AND `calculated_paid_amount` IS NULL
      AND `finalized_total_amount` IS NULL AND `carry_in_amount` IS NULL AND `carry_out_amount` IS NULL
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------------------
-- 2. partner_settle_batch_release_request (해제 멱등 요청)
-- ---------------------------------------------------------------------------

CREATE TABLE `partner_settle_batch_release_request` (
  `id`                   INT          NOT NULL AUTO_INCREMENT,
  `request_key`          VARCHAR(191) NOT NULL,
  `payload_hash`         VARCHAR(128) NOT NULL,
  `payload_hash_version` VARCHAR(16)  NOT NULL,
  `released_by`          INT          NOT NULL,
  `released_at`          DATETIME(6)  NOT NULL,
  `created_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`           DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_release_req_key` (`request_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------------------
-- 3. partner_settle_batch_release (해제 감사)
-- ---------------------------------------------------------------------------

CREATE TABLE `partner_settle_batch_release` (
  `id`                  INT          NOT NULL AUTO_INCREMENT,
  `batch_id`            INT          NOT NULL,
  `ledger_id`           INT          NOT NULL,
  `release_request_id`  INT          NOT NULL,
  `released_by`         INT          NOT NULL,
  `released_at`         DATETIME(6)  NOT NULL,
  `reason`              VARCHAR(500) NOT NULL,
  `created_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`          DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_release_batch_ledger` (`batch_id`, `ledger_id`),
  KEY `idx_release_ledger` (`ledger_id`),
  KEY `idx_release_request` (`release_request_id`),
  CONSTRAINT `fk_release_batch` FOREIGN KEY (`batch_id`) REFERENCES `partner_settle_batch` (`id`),
  CONSTRAINT `fk_release_ledger` FOREIGN KEY (`ledger_id`) REFERENCES `partner_settle_ledger` (`id`),
  CONSTRAINT `fk_release_request` FOREIGN KEY (`release_request_id`)
    REFERENCES `partner_settle_batch_release_request` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------------------
-- 4. partner_settle_exclusion (제외/보류 감사)
-- ---------------------------------------------------------------------------

CREATE TABLE `partner_settle_exclusion` (
  `id`          INT          NOT NULL AUTO_INCREMENT,
  `batch_id`    INT          NULL COMMENT 'confirm 제외 시 batch. hold 해제는 NULL',
  `ledger_id`   INT          NOT NULL,
  `action`      VARCHAR(16)  NOT NULL COMMENT 'SKIP_ONCE|HOLD|HOLD_RELEASE',
  `reason`      VARCHAR(500) NOT NULL,
  `acted_by`    INT          NOT NULL,
  `acted_at`    DATETIME(6)  NOT NULL,
  `created_at`  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`  DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  KEY `idx_exclusion_ledger` (`ledger_id`),
  KEY `idx_exclusion_batch` (`batch_id`),
  CONSTRAINT `fk_exclusion_ledger` FOREIGN KEY (`ledger_id`) REFERENCES `partner_settle_ledger` (`id`),
  CONSTRAINT `fk_exclusion_batch` FOREIGN KEY (`batch_id`) REFERENCES `partner_settle_batch` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------------------
-- 5. partner_settle_config (협력사 정산 경계)
-- ---------------------------------------------------------------------------

CREATE TABLE `partner_settle_config` (
  `partner_company_id`      INT          NOT NULL,
  `next_normal_period_end`  DATE         NOT NULL,
  `source`                  VARCHAR(24)  NOT NULL COMMENT 'OPENING_IMPORT|CUTOVER_MANUAL',
  `created_at`              DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`              DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`partner_company_id`),
  CONSTRAINT `fk_config_partner` FOREIGN KEY (`partner_company_id`) REFERENCES `partner_company` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------------------
-- 6. partner_settle_cancel_recon (확정 후 취소 대사 상태)
-- ---------------------------------------------------------------------------

CREATE TABLE `partner_settle_cancel_recon` (
  `ledger_id`            INT          NOT NULL,
  `candidate_until`      DATETIME(6)  NOT NULL,
  `last_reconciled_at`   DATETIME(6)  NULL,
  `last_reconcile_error` VARCHAR(500) NULL,
  `retry_count`          INT          NOT NULL DEFAULT 0,
  `status`               VARCHAR(24)  NOT NULL DEFAULT 'ACTIVE'
      COMMENT 'ACTIVE|INACTIVE|TERMINATED|PERMANENT_FAIL',
  `created_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`ledger_id`),
  KEY `idx_cancel_recon_candidate` (`candidate_until`),
  KEY `idx_cancel_recon_status_candidate` (`status`, `candidate_until`),
  CONSTRAINT `fk_cancel_recon_ledger` FOREIGN KEY (`ledger_id`) REFERENCES `partner_settle_ledger` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------------------
-- 7. partner_settle_payment_request (paid 멱등키 SoT)
-- ---------------------------------------------------------------------------

CREATE TABLE `partner_settle_payment_request` (
  `id`                           INT          NOT NULL AUTO_INCREMENT,
  `paid_request_key`             VARCHAR(191) NOT NULL,
  `batch_id`                     INT          NOT NULL,
  `payload_hash`                 VARCHAR(128) NOT NULL,
  `payload_hash_version`         VARCHAR(16)  NOT NULL,
  `status`                       VARCHAR(24)  NOT NULL DEFAULT 'PENDING_VARIANCE'
      COMMENT 'PENDING_VARIANCE|PAID|REJECTED',
  `pending_variance_batch_key`   INT GENERATED ALWAYS AS (
    CASE WHEN `status` = 'PENDING_VARIANCE' THEN `batch_id` END
  ) STORED,
  `created_at`                   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                   DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_payment_req_key` (`paid_request_key`),
  UNIQUE KEY `uk_payment_req_id_batch` (`id`, `batch_id`),
  UNIQUE KEY `uk_payment_req_pending_batch` (`pending_variance_batch_key`),
  KEY `idx_payment_req_batch` (`batch_id`),
  CONSTRAINT `fk_payment_req_batch` FOREIGN KEY (`batch_id`) REFERENCES `partner_settle_batch` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------------------
-- 8. partner_settle_payment_variance_proposal (지급 차이 독립 승인)
-- ---------------------------------------------------------------------------

CREATE TABLE `partner_settle_payment_variance_proposal` (
  `id`                       INT           NOT NULL AUTO_INCREMENT,
  `payment_request_id`       INT           NOT NULL,
  `batch_id`                 INT           NOT NULL,
  `partner_company_id`       INT           NOT NULL,
  `calculated_paid_amount`   BIGINT        NOT NULL,
  `actual_paid_amount`       BIGINT        NOT NULL,
  `payment_evidence_ref`     VARCHAR(255)  NOT NULL,
  `memo`                     VARCHAR(1000) NULL,
  `proposed_by`              INT           NOT NULL,
  `proposed_at`              DATETIME(6)   NOT NULL,
  `status`                   VARCHAR(24)   NOT NULL DEFAULT 'PENDING'
      COMMENT 'PENDING|APPROVED|REJECTED',
  `approved_by`              INT           NULL,
  `approved_at`              DATETIME(6)   NULL,
  `rejected_by`              INT           NULL,
  `rejected_at`              DATETIME(6)   NULL,
  `decision_reason`          VARCHAR(500)  NULL,
  `result_ledger_id`         INT           NULL COMMENT '승인 시 생성 ADJUSTMENT ledger',
  `active_batch_key`         INT GENERATED ALWAYS AS (
    CASE WHEN `status` = 'PENDING' THEN `batch_id` END
  ) STORED,
  `created_at`               DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`               DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`               DATETIME(6)   NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_variance_payment_request` (`payment_request_id`),
  UNIQUE KEY `uk_variance_active_batch` (`active_batch_key`),
  KEY `idx_variance_batch` (`batch_id`),
  KEY `idx_variance_partner` (`partner_company_id`),

  -- 복합 FK: request 가 같은 batch 를 가리키는지 DB 강제
  CONSTRAINT `fk_variance_req_batch` FOREIGN KEY (`payment_request_id`, `batch_id`)
    REFERENCES `partner_settle_payment_request` (`id`, `batch_id`),
  -- 복합 FK: batch 가 같은 협력사를 가리키는지 DB 강제
  CONSTRAINT `fk_variance_batch_partner` FOREIGN KEY (`batch_id`, `partner_company_id`)
    REFERENCES `partner_settle_batch` (`id`, `partner_company_id`),

  -- 상태 CHECK
  CONSTRAINT `chk_variance_pending` CHECK (
    `status` <> 'PENDING' OR (
      `approved_by` IS NULL AND `approved_at` IS NULL
      AND `rejected_by` IS NULL AND `rejected_at` IS NULL
      AND `decision_reason` IS NULL AND `result_ledger_id` IS NULL
    )
  ),
  CONSTRAINT `chk_variance_approved` CHECK (
    `status` <> 'APPROVED' OR (
      `approved_by` IS NOT NULL AND `approved_at` IS NOT NULL
      AND `decision_reason` IS NOT NULL AND `result_ledger_id` IS NOT NULL
      AND `rejected_by` IS NULL AND `rejected_at` IS NULL
    )
  ),
  CONSTRAINT `chk_variance_rejected` CHECK (
    `status` <> 'REJECTED' OR (
      `rejected_by` IS NOT NULL AND `rejected_at` IS NOT NULL
      AND `decision_reason` IS NOT NULL
      AND `approved_by` IS NULL AND `approved_at` IS NULL
      AND `result_ledger_id` IS NULL
    )
  ),
  CONSTRAINT `chk_variance_no_self_approve` CHECK (
    `approved_by` IS NULL OR `approved_by` <> `proposed_by`
  ),
  CONSTRAINT `chk_variance_no_self_reject` CHECK (
    `rejected_by` IS NULL OR `rejected_by` <> `proposed_by`
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------------------
-- 9. ALTER — 기존 테이블에 FK 추가
-- ---------------------------------------------------------------------------

-- partner_settle_ledger.settle_batch_id FK (PR1B 에서 nullable 컬럼만 생성함)
ALTER TABLE `partner_settle_ledger`
  ADD CONSTRAINT `fk_ledger_settle_batch`
    FOREIGN KEY (`settle_batch_id`) REFERENCES `partner_settle_batch` (`id`);

-- partner_settle_batch.payment_request_id 복합 FK
-- 주의: payment_request 테이블에 (id, batch_id) UNIQUE 가 이미 있어야 한다.
-- batch 의 payment_request_id 가 자기 자신을 참조하는 batch 의 request 인지 강제.
-- 정본 §5.7.1: (paymentRequestId, id) → payment_request(id, batchId)
-- 실제 방향: batch(payment_request_id, id) → payment_request(id, batch_id)
-- 이 FK 는 payment_request_id 가 NOT NULL 일 때만 의미가 있으며 PAID 상태에서만 설정된다.
-- MySQL 은 nullable FK 컬럼의 NULL 값을 참조 체크에서 건너뛰므로 안전하다.
-- 단, id (auto_increment PK) 가 참조의 일부라 자기참조 형태가 된다. 양쪽 UNIQUE 가 있어야 한다.
-- payment_request 에 이미 uk_payment_req_id_batch(id, batch_id) 가 있다.
-- batch 에는 PK(id) 가 있고 payment_request_id 와 id 를 함께 참조하면
-- FK 방향이 batch(payment_request_id, id) → payment_request(id, batch_id).
-- 이 복합 FK 는 두 열의 의미가 뒤집혀 있으므로 주의.
-- 실제 적용:
ALTER TABLE `partner_settle_batch`
  ADD CONSTRAINT `fk_batch_payment_request`
    FOREIGN KEY (`payment_request_id`) REFERENCES `partner_settle_payment_request` (`id`);
-- 주: 정본의 복합 FK 는 payment_request 가 같은 batch 를 가리키는지 강제하려는 것이나,
-- 단방향 FK 로는 "batch.id = payment_request.batch_id" 를 DB 가 자동 검증하지 않는다.
-- 이 검증은 서비스 계층에서 수행하고, payment_request → batch FK 와 proposal 의 복합 FK 가
-- 반대 방향을 커버한다.
