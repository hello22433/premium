-- PR1a Wallet: wallet_account + wallet_transaction
-- Cross-Cutting Invariants §1 (row split), §2 (idempotency key catalog)
-- owner_type='SETTLEMENT_CODE' 단일값 (CHECK + UNIQUE(owner_type, owner_id))

CREATE TABLE `wallet_account` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `owner_type` VARCHAR(20) NOT NULL COMMENT 'SETTLEMENT_CODE 단일값',
  `owner_id` VARCHAR(50) NOT NULL COMMENT 'user.settlement_code 값 (예: company-123)',
  `deposit_balance` INT NOT NULL DEFAULT 0 COMMENT '예치금 잔액',
  `credit_limit` INT NOT NULL DEFAULT 0 COMMENT '여신 한도',
  `credit_used_amount` INT NOT NULL DEFAULT 0 COMMENT '여신 사용액',
  `credit_excess_amount` INT NOT NULL DEFAULT 0 COMMENT '신용초과 사용액',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY `uq_wallet_owner` (`owner_type`, `owner_id`),
  CONSTRAINT `chk_wallet_owner_type` CHECK (`owner_type` = 'SETTLEMENT_CODE')
) COMMENT='wallet 잔액 단일 테이블 (settlement_code 단위)';

CREATE TABLE `wallet_transaction` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `wallet_account_id` BIGINT NOT NULL,
  `order_id` INT NULL,
  `order_delivery_id` INT NULL,
  `type` VARCHAR(40) NOT NULL COMMENT 'CONFIRM | CANCEL | FAIL_REFUND | DISCARD_REFUND | RESEND_DEDUCT | SETTLE_RELEASE | SETTLE_UNDO | GRANT 등',
  `resource_type` VARCHAR(20) NOT NULL COMMENT 'DEPOSIT | CREDIT | CREDIT_EXCESS | POINT',
  `amount` INT NOT NULL COMMENT '차감은 음수, 적립/복구는 양수',
  `balance_after` INT NULL COMMENT '해당 resource_type 잔액 갱신 후 값',
  `memo` VARCHAR(500) NULL,
  `idempotency_key` VARCHAR(120) NOT NULL COMMENT '{event}:{orderId}:{deliveryId?}:{resource}:{cycle?}',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY `uq_wallet_tx_idempotency` (`idempotency_key`),
  KEY `idx_wallet_tx_order` (`order_id`),
  KEY `idx_wallet_tx_delivery` (`order_delivery_id`),
  KEY `idx_wallet_tx_account` (`wallet_account_id`)
) COMMENT='wallet 잔액 변동 ledger';
