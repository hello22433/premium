-- PR1a Wallet: order_payment_allocation + order_payment_allocation_line
-- Cross-Cutting Invariants §5 (카드할증 풀 모델) + §8 (풀 기반 환불)

CREATE TABLE `order_payment_allocation` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `order_id` INT NOT NULL,
  `wallet_account_id` BIGINT NOT NULL,
  `gross_settlement_amount` INT NOT NULL COMMENT 'Σ line.gross_settlement_amount (카드할증 미포함)',
  `point_used_amount` INT NOT NULL DEFAULT 0,
  `payable_settlement_amount` INT NOT NULL COMMENT '= card_surcharge_total (deposit + credit + credit_excess 합과 동일)',
  `deposit_used_amount` INT NOT NULL DEFAULT 0,
  `credit_used_amount` INT NOT NULL DEFAULT 0,
  `credit_excess_amount` INT NOT NULL DEFAULT 0,
  `card_surcharge_amount` INT NOT NULL DEFAULT 0 COMMENT '주문 단위 카드할증 풀',
  `card_surcharge_applied` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '발송확정 시점 snapshot. 환불 시 applyCardSurcharge() 호출에 사용',
  `has_discount` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '할인/할증 적용 여부 (mutex 검증)',
  `settle_method_snapshot` VARCHAR(20) NULL COMMENT '발송확정 시점 order.settle_method snapshot',
  -- 환불 누적 (풀 기반)
  `point_restored_amount` INT NOT NULL DEFAULT 0,
  `credit_excess_restored_amount` INT NOT NULL DEFAULT 0,
  `credit_used_restored_amount` INT NOT NULL DEFAULT 0,
  `deposit_restored_amount` INT NOT NULL DEFAULT 0,
  `point_skipped_expired_amount` INT NOT NULL DEFAULT 0 COMMENT '만료로 복구 안 한 누적 (audit)',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY `uq_order_payment_allocation_order` (`order_id`),
  KEY `idx_allocation_wallet` (`wallet_account_id`)
) COMMENT='주문 단위 정산 스냅샷';

CREATE TABLE `order_payment_allocation_line` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `allocation_id` BIGINT NOT NULL,
  `order_id` INT NOT NULL,
  `order_product_mapping_id` INT NOT NULL,
  `order_delivery_id` INT NULL COMMENT '신규 흐름은 NOT NULL. legacy fallback만 NULL',
  `product_id` INT NULL,
  `brand_id` INT NULL,
  `category` VARCHAR(100) NULL,
  `partner_company_id` INT NULL,
  `order_type` VARCHAR(30) NOT NULL,
  `gross_settlement_amount` INT NOT NULL COMMENT '카드할증 미포함. calculateSettlementPrice(mapping, false, delivery)',
  `applied_fee_percent` INT NULL COMMENT '발송확정 시점 fee snapshot',
  `applied_price_adjustment` VARCHAR(20) NULL COMMENT 'DISCOUNT | ADDITIONAL | NULL',
  `point_used_amount` INT NOT NULL DEFAULT 0,
  `payable_base` INT NOT NULL COMMENT '= gross_settlement_amount - point_used_amount',
  `deposit_used_amount` INT NOT NULL DEFAULT 0 COMMENT '정보용. 환불은 풀 기반',
  `credit_used_amount` INT NOT NULL DEFAULT 0 COMMENT '정보용',
  `credit_excess_amount` INT NOT NULL DEFAULT 0 COMMENT '정보용',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY `idx_allocation_line_order` (`order_id`),
  KEY `idx_allocation_line_delivery` (`order_delivery_id`),
  KEY `idx_allocation_line_alloc` (`allocation_id`)
) COMMENT='배송별 정산 스냅샷 라인';
