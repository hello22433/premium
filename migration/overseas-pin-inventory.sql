-- =================================================================
-- overseas-pin-inventory.sql
-- 해외 재고형 쿠폰 PIN 직접 이메일 — additive migration
-- rev5 §4 + ralplan T0
-- 모든 신규 컬럼은 nullable/default → old binary 호환
-- =================================================================

-- ─── 1. 상품 설정 ───
CREATE TABLE IF NOT EXISTS `inventory_coupon_product_config` (
  `product_id`            BIGINT          NOT NULL COMMENT 'FK) product.id, 1:1',
  `face_value_amount`     DECIMAL(19,4)   NOT NULL COMMENT '액면가 (0 초과)',
  `currency_code`         CHAR(3)         NOT NULL COMMENT 'ISO 4217 통화코드',
  `primary_code_label`    VARCHAR(100)    NOT NULL COMMENT '주코드 라벨',
  `secondary_code_label`  VARCHAR(100)    NULL     COMMENT '보조코드 라벨 (NULL=보조코드 렌더링 금지)',
  `how_to_use`            TEXT            NOT NULL COMMENT '사용방법',
  `notice`                TEXT            NOT NULL COMMENT '유의사항',
  `template_locale`       VARCHAR(10)     NOT NULL DEFAULT 'en' COMMENT '템플릿 로케일',
  `low_stock_threshold`   INT             NOT NULL DEFAULT 0    COMMENT '저재고 임계치',
  `default_from_email`    VARCHAR(100)    NOT NULL COMMENT '기본 발신 이메일',
  `default_subject`       VARCHAR(255)    NOT NULL COMMENT '기본 제목',
  `version`               INT             NOT NULL DEFAULT 1    COMMENT '낙관적 잠금 버전',
  `code_schema_version`   INT             NOT NULL DEFAULT 1    COMMENT '코드 구조 버전',
  `created_at`            DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`            DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`            DATETIME(6)     NULL,
  PRIMARY KEY (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 2. 입고 배치 ───
CREATE TABLE IF NOT EXISTS `inventory_pin_import_batch` (
  `id`                         BIGINT        NOT NULL AUTO_INCREMENT,
  `supplier_name`              VARCHAR(200)  NOT NULL COMMENT '실제 구매처명',
  `source_partner_company_id`  BIGINT        NULL     COMMENT 'FK) partner_company.id',
  `purchase_reference`         VARCHAR(200)  NULL     COMMENT '발주번호/인보이스',
  `purchased_at`               DATE          NULL     COMMENT '구매일',
  `original_file_name`         VARCHAR(255)  NOT NULL COMMENT '원본 파일명',
  `file_checksum`              BINARY(32)    NOT NULL COMMENT 'SHA-256',
  `idempotency_key`            VARCHAR(100)  NOT NULL COMMENT '멱등키',
  `request_hash`               BINARY(32)    NOT NULL COMMENT 'canonical hash',
  `spool_id`                   CHAR(26)      NOT NULL COMMENT '암호화 spool 논리 식별자',
  `spool_key_version`          VARCHAR(32)   NOT NULL COMMENT 'spool key-ring version',
  `spool_expires_at`           DATETIME(6)   NOT NULL COMMENT 'spool 삭제 상한',
  `spool_deleted_at`           DATETIME(6)   NULL     COMMENT '물리 삭제 확인 시각',
  `status`                     VARCHAR(20)   NOT NULL COMMENT 'VALIDATING/COMMITTED/REJECTED',
  `owner_token`                VARCHAR(64)   NULL     COMMENT 'VALIDATING lease 소유자',
  `lease_until`                DATETIME(6)   NULL     COMMENT 'stale 복구 기준',
  `total_count`                INT           NOT NULL DEFAULT 0,
  `committed_count`            INT           NOT NULL DEFAULT 0,
  `rejected_count`             INT           NOT NULL DEFAULT 0,
  `imported_by_user_id`        INT           NOT NULL,
  `committed_at`               DATETIME(6)   NULL,
  `created_at`                 DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                 DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                 DATETIME(6)   NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_batch_spool` (`spool_id`),
  UNIQUE KEY `uk_batch_user_idem` (`imported_by_user_id`, `idempotency_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 3. 입고 오류 ───
CREATE TABLE IF NOT EXISTS `inventory_pin_import_error` (
  `id`                BIGINT        NOT NULL AUTO_INCREMENT,
  `batch_id`          BIGINT        NOT NULL,
  `row_number`        INT           NOT NULL,
  `field`             VARCHAR(100)  NOT NULL,
  `error_code`        VARCHAR(100)  NOT NULL,
  `masked_identifier` VARCHAR(200)  NULL     COMMENT '마스킹된 식별자',
  PRIMARY KEY (`id`),
  INDEX `idx_error_batch` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 4. PIN item ───
CREATE TABLE IF NOT EXISTS `inventory_pin_item` (
  `id`                          BIGINT        NOT NULL AUTO_INCREMENT,
  `crypto_context_id`           CHAR(26)      NOT NULL COMMENT 'AEAD AAD용 불변 ULID',
  `import_batch_id`             BIGINT        NOT NULL,
  `product_id`                  BIGINT        NOT NULL,
  `code_schema_version`         INT           NOT NULL COMMENT '입고 시 구조 버전',
  `primary_code_ciphertext`     TEXT          NOT NULL COMMENT 'AEAD envelope',
  `secondary_code_ciphertext`   TEXT          NULL,
  `crypto_key_version`          VARCHAR(32)   NOT NULL,
  `primary_code_fingerprint`    BINARY(32)    NOT NULL COMMENT 'HMAC-SHA-256',
  `pair_fingerprint`            BINARY(32)    NOT NULL COMMENT 'pair HMAC',
  `primary_code_masked`         VARCHAR(200)  NOT NULL,
  `secondary_code_masked`       VARCHAR(200)  NULL,
  `status`                      VARCHAR(20)   NOT NULL DEFAULT 'AVAILABLE',
  `assigned_order_delivery_id`  BIGINT        NULL     COMMENT '현재 귀속 배송건',
  `assigned_at`                 DATETIME(6)   NULL,
  `expires_on`                  DATE          NULL     COMMENT 'KST 유효종료일',
  `voided_at`                   DATETIME(6)   NULL,
  `void_reason`                 VARCHAR(500)  NULL     COMMENT 'PIN 원문 금지',
  `created_at`                  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                  DATETIME(6)   NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_item_crypto_ctx` (`crypto_context_id`),
  UNIQUE KEY `uk_item_product_primary_fp` (`product_id`, `primary_code_fingerprint`),
  UNIQUE KEY `uk_item_product_pair_fp` (`product_id`, `pair_fingerprint`),
  UNIQUE KEY `uk_item_assigned_delivery` (`assigned_order_delivery_id`),
  INDEX `idx_item_allocation` (`product_id`, `code_schema_version`, `status`, `expires_on`, `id`),
  INDEX `idx_item_batch` (`import_batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 5. 이메일 attempt ───
CREATE TABLE IF NOT EXISTS `inventory_pin_email_attempt` (
  `id`                         BIGINT        NOT NULL AUTO_INCREMENT,
  `inventory_pin_item_id`      BIGINT        NOT NULL,
  `order_delivery_id`          BIGINT        NOT NULL,
  `request_key`                VARCHAR(100)  NOT NULL,
  `attempt_type`               VARCHAR(20)   NOT NULL COMMENT 'INITIAL/RESEND',
  `status`                     VARCHAR(20)   NOT NULL COMMENT 'CLAIMED/SENT/FAILED/UNKNOWN',
  `active_order_delivery_id`   BIGINT GENERATED ALWAYS AS (
    CASE WHEN `status` = 'CLAIMED' THEN `order_delivery_id` ELSE NULL END
  ) STORED COMMENT 'CLAIMED일 때만 orderDeliveryId',
  `target_version`             INT           NOT NULL COMMENT 'claim 시점 수신정보 버전',
  `claim_token`                VARCHAR(64)   NOT NULL,
  `claimed_at`                 DATETIME(6)   NOT NULL,
  `completed_at`               DATETIME(6)   NULL,
  `provider_code`              VARCHAR(100)  NULL,
  `error_code`                 VARCHAR(100)  NULL,
  `error_message`              VARCHAR(500)  NULL     COMMENT 'PIN/본문/수신 이메일 원문 금지',
  `created_at`                 DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                 DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                 DATETIME(6)   NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_attempt_delivery_request` (`order_delivery_id`, `request_key`),
  UNIQUE KEY `uk_attempt_active_delivery` (`active_order_delivery_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 6. 이메일 outbox ───
CREATE TABLE IF NOT EXISTS `inventory_pin_email_outbox` (
  `id`                  BIGINT        NOT NULL AUTO_INCREMENT,
  `order_delivery_id`   BIGINT        NOT NULL,
  `state`               VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
  `due_at`              DATETIME(6)   NOT NULL,
  `owner_token`         VARCHAR(64)   NULL,
  `lease_until`         DATETIME(6)   NULL,
  `attempt_count`       INT           NOT NULL DEFAULT 0,
  `pending_request_key` VARCHAR(100)  NULL,
  `last_error_code`     VARCHAR(100)  NULL,
  `created_at`          DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`          DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`          DATETIME(6)   NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_outbox_delivery` (`order_delivery_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 7. 결제 체인 ───
CREATE TABLE IF NOT EXISTS `inventory_pin_billing_chain` (
  `id`                            BIGINT         NOT NULL AUTO_INCREMENT,
  `wallet_debit_allocation_id`    BIGINT         NOT NULL COMMENT '최초 wallet 차감 allocation 불변 ID',
  `current_order_delivery_id`     BIGINT         NOT NULL COMMENT '현재 결제 소유 배송건',
  `settle_amount`                 DECIMAL(19,4)  NOT NULL COMMENT '최초 차감 금액 (불변)',
  `state`                         VARCHAR(20)    NOT NULL COMMENT 'DEBITED/REFUNDED',
  `refunded_at`                   DATETIME(6)    NULL,
  `version`                       INT            NOT NULL DEFAULT 1,
  `created_at`                    DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                    DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                    DATETIME(6)    NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_chain_wallet_debit` (`wallet_debit_allocation_id`),
  UNIQUE KEY `uk_chain_current_delivery` (`current_order_delivery_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 8. 재발급 이력 ───
CREATE TABLE IF NOT EXISTS `inventory_pin_reissue` (
  `id`                               BIGINT        NOT NULL AUTO_INCREMENT,
  `old_order_delivery_id`            BIGINT        NOT NULL,
  `new_order_delivery_id`            BIGINT        NOT NULL,
  `old_inventory_pin_item_id`        BIGINT        NOT NULL,
  `new_inventory_pin_item_id`        BIGINT        NOT NULL,
  `inventory_pin_billing_chain_id`   BIGINT        NOT NULL,
  `status`                           VARCHAR(20)   NOT NULL DEFAULT 'COMPLETED',
  `reason`                           VARCHAR(500)  NOT NULL COMMENT 'PIN 원문 금지',
  `created_by_user_id`               INT           NOT NULL,
  `created_at`                       DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                       DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                       DATETIME(6)   NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_reissue_old_delivery` (`old_order_delivery_id`),
  UNIQUE KEY `uk_reissue_new_delivery` (`new_order_delivery_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 9. 정책 싱글턴 (allocation/applications) ───
CREATE TABLE IF NOT EXISTS `pin_inventory_policy` (
  `id`                  INT           NOT NULL COMMENT '싱글턴 PK (항상 1)',
  `applications_open`   TINYINT(1)    NOT NULL DEFAULT 0,
  `allocation_enabled`  TINYINT(1)    NOT NULL DEFAULT 0,
  `version`             INT           NOT NULL DEFAULT 1,
  `updated_by_user_id`  INT           NULL,
  `created_at`          DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`          DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`          DATETIME(6)   NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- seed: false/false 초기값
INSERT IGNORE INTO `pin_inventory_policy` (`id`, `applications_open`, `allocation_enabled`, `version`)
VALUES (1, 0, 0, 1);

-- ─── 10. 직접 PIN 발송 정책 싱글턴 (send-stop) ───
CREATE TABLE IF NOT EXISTS `direct_pin_delivery_policy` (
  `id`                  INT           NOT NULL COMMENT '싱글턴 PK (항상 1)',
  `send_enabled`        TINYINT(1)    NOT NULL DEFAULT 0,
  `version`             INT           NOT NULL DEFAULT 1,
  `updated_by_user_id`  INT           NULL,
  `reason`              VARCHAR(500)  NULL     COMMENT '변경 사유',
  `created_at`          DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`          DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`          DATETIME(6)   NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `direct_pin_delivery_policy` (`id`, `send_enabled`, `version`)
VALUES (1, 0, 1);

-- ─── 11. 외부 API 재고형 쿠폰 신청 ───
CREATE TABLE IF NOT EXISTS `external_api_pin_inventory_request` (
  `id`                    BIGINT        NOT NULL AUTO_INCREMENT,
  `api_app_id`            BIGINT        NOT NULL,
  `status`                VARCHAR(20)   NOT NULL COMMENT 'PENDING/APPROVED/REJECTED/CANCELLED',
  `pending_api_app_id`    BIGINT GENERATED ALWAYS AS (
    CASE WHEN `status` = 'PENDING' THEN `api_app_id` ELSE NULL END
  ) STORED COMMENT 'PENDING일 때만 apiAppId',
  `requested_by_user_id`  INT           NOT NULL,
  `request_reason`        VARCHAR(500)  NOT NULL,
  `decided_by_user_id`    INT           NULL,
  `decision_reason`       VARCHAR(500)  NULL,
  `decided_at`            DATETIME(6)   NULL,
  `created_at`            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`            DATETIME(6)   NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_request_pending_app` (`pending_api_app_id`),
  INDEX `idx_request_app` (`api_app_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 12. 기존 테이블 additive 컬럼 ───

-- order_delivery: 직접 PIN 상태 + 결제 체인
ALTER TABLE `order_delivery`
  ADD COLUMN `direct_pin_fulfillment_status` VARCHAR(20) NULL COMMENT '직접 PIN fulfillment 상태' AFTER `report_owner_token`,
  ADD COLUMN `inventory_pin_billing_chain_id` BIGINT NULL COMMENT 'FK) inventory_pin_billing_chain.id' AFTER `direct_pin_fulfillment_status`,
  ADD COLUMN `delivery_target_version` INT NOT NULL DEFAULT 0 COMMENT '수신정보 변경 버전' AFTER `inventory_pin_billing_chain_id`,
  ADD COLUMN `direct_pin_latest_attempt_id` BIGINT NULL COMMENT '최신 attempt ID' AFTER `delivery_target_version`,
  ADD COLUMN `direct_pin_sent_at` DATETIME(6) NULL COMMENT '최초 SENT 시각' AFTER `direct_pin_latest_attempt_id`,
  ADD COLUMN `external_request_hash` BINARY(32) NULL COMMENT '외부 API 요청 payload hash' AFTER `direct_pin_sent_at`;

-- order_product_mapping: 직접 PIN 이메일 스냅샷
ALTER TABLE `order_product_mapping`
  ADD COLUMN `direct_pin_email_snapshot` JSON NULL COMMENT '직접 PIN 이메일 스냅샷' AFTER `snapshot_product_image_path`;

-- api_app: 재고형 쿠폰 승인
ALTER TABLE `api_app`
  ADD COLUMN `pin_inventory_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '재고형 해외쿠폰 주문 승인' AFTER `require_external_order_id`;

-- order_delivery_refund: 결제 체인 환불 멱등성
ALTER TABLE `order_delivery_refund`
  ADD COLUMN `inventory_pin_billing_chain_id` BIGINT NULL AFTER `ssg_recover_escalated_at`,
  ADD UNIQUE KEY `uk_order_delivery_refund_billing_chain` (`inventory_pin_billing_chain_id`);

-- inventory_coupon_product_config: 유효기간 정책 (snapshot 빌드에 필요)
ALTER TABLE `inventory_coupon_product_config`
  ADD COLUMN `validity_days`             INT       NOT NULL DEFAULT 0 COMMENT '유효기간 일수 (0=무제한)' AFTER `code_schema_version`,
  ADD COLUMN `validity_starts_next_day`  TINYINT(1) NOT NULL DEFAULT 0 COMMENT '유효기간 시작: 0=당일, 1=다음날' AFTER `validity_days`;
