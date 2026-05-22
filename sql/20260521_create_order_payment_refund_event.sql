-- PR1a Wallet: order_payment_refund_event
-- Cross-Cutting Invariants §8 (풀 기반 환불 ledger + 재발송 역환불)

CREATE TABLE `order_payment_refund_event` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `allocation_id` BIGINT NOT NULL,
  `order_id` INT NOT NULL,
  `event_type` VARCHAR(30) NOT NULL COMMENT 'fail_refund | discard_refund | cancel',
  `affected_delivery_ids` JSON NOT NULL COMMENT '이 이벤트에서 환불된 delivery id 배열',
  `refunded_gross_base` INT NOT NULL COMMENT 'Σ line.gross_settlement_amount (라인 base, 포인트 포함)',
  `refunded_payable_base` INT NOT NULL COMMENT 'Σ (line.gross - line.point_used). 카드할증 base 산정용',
  `refunded_card_surcharge_amount` INT NOT NULL COMMENT 'remaining-payable-base delta로 계산된 카드할증 환불액',
  `refunded_point_amount` INT NOT NULL DEFAULT 0,
  `refunded_deposit_amount` INT NOT NULL DEFAULT 0,
  `refunded_credit_used_amount` INT NOT NULL DEFAULT 0,
  `refunded_credit_excess_amount` INT NOT NULL DEFAULT 0,
  `point_skipped_expired_amount` INT NOT NULL DEFAULT 0,
  `idempotency_key` VARCHAR(120) NOT NULL,
  `reversed_at` DATETIME(6) NULL COMMENT '재발송 역환불 시 이 ledger를 되돌린 시각',
  `reversed_by_wallet_transaction_id` BIGINT NULL COMMENT '역환불을 수행한 wallet_transaction.id',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY `uq_refund_event_idempotency` (`idempotency_key`),
  KEY `idx_refund_event_order` (`order_id`),
  KEY `idx_refund_event_alloc` (`allocation_id`)
) COMMENT='주문 단위 부분 환불 ledger';
