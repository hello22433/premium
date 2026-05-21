-- PR1a Wallet: point_grant + point_policy_rule
-- Cross-Cutting Invariants §6 (포인트 grant 선택 순서)

CREATE TABLE `point_grant` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `wallet_account_id` BIGINT NOT NULL,
  `original_amount` INT NOT NULL COMMENT '발급 시점 금액',
  `remaining_amount` INT NOT NULL COMMENT '잔여 금액',
  `expires_at` DATETIME NULL COMMENT 'NULL = 만료 없음',
  `reason` VARCHAR(200) NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY `idx_point_grant_wallet_expire` (`wallet_account_id`, `expires_at`)
) COMMENT='포인트 grant';

CREATE TABLE `point_policy_rule` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `owner_type` VARCHAR(20) NOT NULL COMMENT 'COMMON | COMPANY | POINT_GRANT',
  `owner_id` BIGINT NULL COMMENT 'owner_type=COMMON이면 NULL',
  `effect` VARCHAR(10) NOT NULL COMMENT 'ALLOW | DENY',
  `scope_type` VARCHAR(30) NOT NULL COMMENT 'PRODUCT | BRAND | CATEGORY | PARTNER_COMPANY | ORDER_TYPE',
  `scope_id` BIGINT NULL,
  `scope_code` VARCHAR(100) NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY `idx_point_policy_owner` (`owner_type`, `owner_id`),
  KEY `idx_point_policy_scope` (`scope_type`, `scope_id`, `scope_code`)
) COMMENT='포인트 사용 가능 정책';

CREATE TABLE `order_point_usage` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `allocation_id` BIGINT NOT NULL,
  `order_id` INT NOT NULL,
  `order_delivery_id` INT NULL,
  `point_grant_id` BIGINT NOT NULL,
  `used_amount` INT NOT NULL,
  `restored_amount` INT NOT NULL DEFAULT 0,
  `skipped_expired_amount` INT NOT NULL DEFAULT 0,
  `expires_at_snapshot` DATETIME NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY `idx_order_point_usage_order` (`order_id`),
  KEY `idx_order_point_usage_delivery` (`order_delivery_id`),
  KEY `idx_order_point_usage_grant` (`point_grant_id`)
) COMMENT='주문/배송별 포인트 grant 사용 기록';
