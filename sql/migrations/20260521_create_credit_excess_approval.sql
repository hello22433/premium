-- PR1a Wallet: credit_excess_approval
-- Open Decision 2: 신용초과 운영관리자 수동 승인 4단계 워크플로 audit trail

CREATE TABLE `credit_excess_approval` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `order_id` INT NOT NULL,
  `wallet_account_id` BIGINT NOT NULL,
  `requested_amount` INT NOT NULL COMMENT '발송확정 시점 payable_settlement_amount',
  `requested_credit_excess_amount` INT NOT NULL COMMENT '신용초과 분배 예상액',
  `reason_text` VARCHAR(200) NOT NULL COMMENT 'Step B 사유 (필수)',
  `requested_by` INT NOT NULL COMMENT '요청한 user.id (기업관리자)',
  `requested_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING | APPROVED | REJECTED | EXPIRED',
  `approved_by` INT NULL COMMENT '승인/거절한 user.id (운영관리자)',
  `approved_at` DATETIME(6) NULL,
  `reject_reason` VARCHAR(200) NULL,
  `consumed_at` DATETIME(6) NULL COMMENT '발송확정에서 사용된 시각 (조건부 UPDATE로 1회만 사용 보장)',
  UNIQUE KEY `uq_credit_excess_consumed` (`id`, `consumed_at`),
  KEY `idx_credit_excess_order` (`order_id`),
  KEY `idx_credit_excess_status` (`status`)
) COMMENT='신용초과 운영관리자 승인 4단계 워크플로';
