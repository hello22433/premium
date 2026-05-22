-- PR1a Wallet: order_delivery_attempt
-- Cross-Cutting Invariants §4 (재발송 흐름 명세, qa D2-11 대응)
-- 모든 fail_refund / resend_deduct 이벤트의 idempotency key cycle = 이 테이블의 PK

CREATE TABLE `order_delivery_attempt` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `order_delivery_id` INT NOT NULL,
  `attempt_type` VARCHAR(20) NOT NULL COMMENT 'INITIAL | RESEND',
  `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING | DEDUCTED | SENT | FAILED | ROLLED_BACK | COMPLETED',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `deducted_at` DATETIME(6) NULL,
  `sent_at` DATETIME(6) NULL,
  `failed_at` DATETIME(6) NULL,
  `completed_at` DATETIME(6) NULL,
  `failure_reason` VARCHAR(500) NULL,
  KEY `idx_delivery_attempt_delivery` (`order_delivery_id`, `status`),
  KEY `idx_delivery_attempt_type` (`attempt_type`)
) COMMENT='발송 시도 universal log (최초 + 재발송)';
