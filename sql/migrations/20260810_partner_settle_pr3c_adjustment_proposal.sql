-- ---------------------------------------------------------------------------
-- PR3C — 소급 재계산 · adjustment proposal (차액 제안)
--
-- 정본 §5.7·§8.4·§8.5. PR3B(20260807_partner_settle_pr3b_reservation.sql) 이후 적용.
--
-- Step 실행 순서가 중요하다:
--   Step 1: ledger 에 adjustment_proposal_id + 보조 UNIQUE (proposal FK 참조 대상)
--   Step 2: proposal 테이블 생성 (Step 1 의 UNIQUE 를 복합 FK 로 참조)
--   Step 3: proposal 인덱스
--   Step 4: 상호 참조 FK + ledger shape/exclusive CHECK
-- ---------------------------------------------------------------------------

-- ====== Step 1: ledger 컬럼 + 보조 UNIQUE ======

ALTER TABLE `partner_settle_ledger`
  ADD COLUMN `adjustment_proposal_id` INT NULL COMMENT 'FK) adjustment proposal provenance';

ALTER TABLE `partner_settle_ledger`
  ADD CONSTRAINT `uk_ledger_adj_proposal` UNIQUE (`adjustment_proposal_id`);

ALTER TABLE `partner_settle_ledger`
  ADD UNIQUE INDEX `uk_ledger_id_partner` (`id`, `partner_company_id`);

ALTER TABLE `partner_settle_ledger`
  ADD UNIQUE INDEX `uk_ledger_adj_proposal_partner` (`id`, `adjustment_proposal_id`, `partner_company_id`);
ALTER TABLE `partner_discount_history`
  ADD UNIQUE INDEX `uk_partner_discount_history_id_partner` (`id`, `partner_company_id`);


-- ====== Step 2: proposal 테이블 생성 ======

CREATE TABLE `partner_settle_adjustment_proposal` (
  `id`                      INT AUTO_INCREMENT PRIMARY KEY,
  `partner_company_id`      INT NOT NULL,
  `sub_item_key`            VARCHAR(32) NOT NULL,
  `source_ledger_id`        INT NULL,
  `discount_change_id`      INT NULL       COMMENT 'FK) partner_discount_history.id — 소급 재계산 dedup 축',
  `proposed_amount`         BIGINT NOT NULL COMMENT '시스템/운영자 제안 차액',
  `approved_amount`         BIGINT NULL    COMMENT '승인 확정 금액 (미승인=NULL)',
  `reason`                  VARCHAR(1000) NOT NULL,
  `status`                  VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `created_by`              INT NULL       COMMENT '제안자 (system=NULL)',
  `decided_by`              INT NULL       COMMENT '승인/반려자',
  `decided_at`              DATETIME(6) NULL,
  `result_ledger_id`        INT NULL       COMMENT '승인 시 생성 ADJUSTMENT ledger',
  `resolution_group_key`    VARCHAR(128) NULL COMMENT '{rootLedgerId}:{discountChangeId}',
  `request_key`             VARCHAR(128) NULL COMMENT '수동 proposal 멱등키',
  `payload_hash`            VARCHAR(128) NULL,
  `payload_hash_version`    VARCHAR(8) NULL,
  `amount_override_reason`  VARCHAR(1000) NULL COMMENT 'approvedAmount != proposedAmount 시 필수',
  `decision_reason`         VARCHAR(1000) NULL COMMENT '반려 사유 (반려 필수, 승인 선택)',
  `created_at`              DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`              DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  -- FK: partner, source/change(협력사 복합 검증), result FK 는 Step 4 에서 ALTER 로 추가
  CONSTRAINT `fk_adj_proposal_partner` FOREIGN KEY (`partner_company_id`) REFERENCES `partner_company`(`id`),
  CONSTRAINT `fk_adj_proposal_source`  FOREIGN KEY (`source_ledger_id`, `partner_company_id`) REFERENCES `partner_settle_ledger`(`id`, `partner_company_id`),
  CONSTRAINT `fk_adj_proposal_change`  FOREIGN KEY (`discount_change_id`, `partner_company_id`) REFERENCES `partner_discount_history`(`id`, `partner_company_id`),

  -- UNIQUE
  CONSTRAINT `uk_adj_proposal_source_change` UNIQUE (`source_ledger_id`, `discount_change_id`),
  CONSTRAINT `uk_adj_proposal_request_key`   UNIQUE (`request_key`),

  -- CHECK: status enum
  CONSTRAINT `chk_adj_proposal_status` CHECK (`status` IN ('PENDING','APPROVED','REJECTED')),

  -- CHECK: 자기승인 차단
  CONSTRAINT `chk_adj_proposal_self_decision` CHECK (`created_by` IS NULL OR `created_by` != `decided_by`),

  -- CHECK: APPROVED — 필수 필드 (decisionReason 선택)
  CONSTRAINT `chk_adj_proposal_approved` CHECK (
    `status` != 'APPROVED' OR (
      `decided_by` IS NOT NULL AND `decided_at` IS NOT NULL AND `approved_amount` IS NOT NULL
    )
  ),

  -- CHECK: REJECTED — 필수 필드 + 금지 필드
  CONSTRAINT `chk_adj_proposal_rejected` CHECK (
    `status` != 'REJECTED' OR (
      `decided_by` IS NOT NULL AND `decided_at` IS NOT NULL AND `decision_reason` IS NOT NULL
      AND `approved_amount` IS NULL AND `result_ledger_id` IS NULL AND `amount_override_reason` IS NULL
    )
  ),

  -- CHECK: PENDING — 모든 결정·결과 필드 금지
  CONSTRAINT `chk_adj_proposal_pending` CHECK (
    `status` != 'PENDING' OR (
      `decided_by` IS NULL AND `decided_at` IS NULL AND `approved_amount` IS NULL
      AND `result_ledger_id` IS NULL AND `decision_reason` IS NULL AND `amount_override_reason` IS NULL
    )
  ),

  -- CHECK: amount override 시 사유 필수
  CONSTRAINT `chk_adj_proposal_override` CHECK (
    `approved_amount` IS NULL OR `approved_amount` = `proposed_amount` OR `amount_override_reason` IS NOT NULL
  ),

  -- CHECK: system/manual XOR — 불완전 row 방지 + actor 불변식
  CONSTRAINT `chk_adj_proposal_origin` CHECK (
    (`discount_change_id` IS NOT NULL AND `source_ledger_id` IS NOT NULL AND `resolution_group_key` IS NOT NULL
     AND `created_by` IS NULL
     AND `request_key` IS NULL AND `payload_hash` IS NULL AND `payload_hash_version` IS NULL)
    OR
    (`request_key` IS NOT NULL AND `payload_hash` IS NOT NULL AND `payload_hash_version` IS NOT NULL
     AND `created_by` IS NOT NULL
     AND `discount_change_id` IS NULL AND `resolution_group_key` IS NULL)
  ),

  -- CHECK: 0원 승인 ↔ resultLedgerId 양방향 불변식
  CONSTRAINT `chk_adj_proposal_result` CHECK (
    `status` != 'APPROVED' OR (
      (`approved_amount` = 0 AND `result_ledger_id` IS NULL)
      OR
      (`approved_amount` != 0 AND `result_ledger_id` IS NOT NULL)
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ====== Step 3: proposal 인덱스 ======

CREATE INDEX `idx_adj_proposal_partner` ON `partner_settle_adjustment_proposal` (`partner_company_id`);
CREATE INDEX `idx_adj_proposal_group`   ON `partner_settle_adjustment_proposal` (`resolution_group_key`, `status`, `id`);
CREATE INDEX `idx_adj_proposal_source`  ON `partner_settle_adjustment_proposal` (`source_ledger_id`);
CREATE INDEX `idx_adj_proposal_cursor`  ON `partner_settle_adjustment_proposal` (`created_at`, `id`);

-- ====== Step 4: 상호 참조 FK + ledger shape/exclusive CHECK ======

-- proposal → ledger result 복합 FK (교차 연결 방지)
ALTER TABLE `partner_settle_adjustment_proposal`
  ADD CONSTRAINT `fk_adj_proposal_result` FOREIGN KEY (`result_ledger_id`, `id`, `partner_company_id`)
    REFERENCES `partner_settle_ledger`(`id`, `adjustment_proposal_id`, `partner_company_id`);

-- ledger → proposal FK
ALTER TABLE `partner_settle_ledger`
  ADD CONSTRAINT `fk_ledger_adj_proposal` FOREIGN KEY (`adjustment_proposal_id`)
    REFERENCES `partner_settle_adjustment_proposal`(`id`);

-- adjustment ADJUSTMENT 의 형태를 DB 가 고정 (PR3A variance_shape 과 동일 패턴)
ALTER TABLE `partner_settle_ledger`
  ADD CONSTRAINT `chk_partner_settle_ledger_adj_shape` CHECK (
    `adjustment_proposal_id` IS NULL OR (
      `source_type` = 'ADJUSTMENT'
      AND `pricing_resolution` = 'DIRECT_AMOUNT'
      AND `idempotency_key` = CONCAT('ADJ:PROPOSAL:', `adjustment_proposal_id`)
      AND `settle_batch_id` IS NULL
      AND `status` = 'NORMAL'
      AND `applied_discount_history_id` IS NULL
      AND `applied_price_percent` = 0
      AND `applied_price_adjustment` = 'DISCOUNT'
      AND `base_amount` = `settle_amount`
      AND `giving_commission_amount` = 0
      AND `receiving_commission_amount` = 0
      AND `vat_amount` = 0
      AND `discount_amount` = 0
      AND `fee_total_amount` = 0
      AND `occurred_at` IS NOT NULL
    )
  );

-- ADJUSTMENT 원장은 variance XOR adjustment provenance 정확히 하나
ALTER TABLE `partner_settle_ledger`
  ADD CONSTRAINT `chk_ledger_adj_exclusive` CHECK (
    `source_type` <> 'ADJUSTMENT'
    OR ((`payment_variance_proposal_id` IS NULL) <> (`adjustment_proposal_id` IS NULL))
  );

-- ====== 롤백 (역순) ======
-- Step 4 역순
-- ALTER TABLE `partner_settle_ledger` DROP CHECK `chk_ledger_adj_exclusive`;
-- ALTER TABLE `partner_settle_ledger` DROP CHECK `chk_partner_settle_ledger_adj_shape`;
-- ALTER TABLE `partner_settle_ledger` DROP FOREIGN KEY `fk_ledger_adj_proposal`;
-- ALTER TABLE `partner_settle_adjustment_proposal` DROP FOREIGN KEY `fk_adj_proposal_result`;
-- Step 3: 인덱스는 테이블과 함께 제거
-- Step 2
-- DROP TABLE `partner_settle_adjustment_proposal`;
-- Step 1 역순
-- ALTER TABLE `partner_settle_ledger` DROP INDEX `uk_ledger_adj_proposal_partner`;
-- ALTER TABLE `partner_settle_ledger` DROP INDEX `uk_ledger_id_partner`;
-- ALTER TABLE `partner_settle_ledger` DROP INDEX `uk_ledger_adj_proposal`;
-- ALTER TABLE `partner_discount_history` DROP INDEX `uk_partner_discount_history_id_partner`;
-- ALTER TABLE `partner_settle_ledger` DROP COLUMN `adjustment_proposal_id`;
