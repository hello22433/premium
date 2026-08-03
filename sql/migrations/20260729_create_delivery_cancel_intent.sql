-- 협력사 쿠폰 취소 전 durable intent.
-- 외부 취소 성공 뒤 workflow fencing을 잃어도 이 행이 재조정 대상을 보존한다.

CREATE TABLE `delivery_cancel_intent` (
  `id`                    BIGINT       NOT NULL AUTO_INCREMENT,
  `order_delivery_id`     INT          NOT NULL,
  `source`                VARCHAR(24)  NOT NULL COMMENT 'EXTERNAL_API|CUSTOMER_SERVICE',
  `status`                VARCHAR(24)  NOT NULL DEFAULT 'PENDING'
      COMMENT 'PENDING|CANCEL_CONFIRMED|DB_APPLIED|REFUND_SUCCEEDED|RESOLVED_NO_REFUND|RECONCILING',
  `reconcile_from_status` VARCHAR(24)  NULL,
  `requested_coupon_status` VARCHAR(24) NOT NULL,
  `refund_required`        TINYINT(1)   NOT NULL DEFAULT 1,
  `requested_by_user_id`   INT          NULL,
  `refund_attempt_id`       BIGINT       NULL,
  `expected_refund_amount`  INT          NULL,
  `expected_refund_scope`   VARCHAR(16)  NULL,
  `owner_token`           VARCHAR(64)  NOT NULL,
  `workflow_version`      BIGINT       NOT NULL,
  `external_cancelled_at` DATETIME(6)  NULL,
  `resolved_at`           DATETIME(6)  NULL,
  `failure_reason`        VARCHAR(500) NULL,
  `state_entered_at`      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_at`            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_delivery_cancel_intent_refund_attempt` (`refund_attempt_id`),
  UNIQUE KEY `uk_delivery_cancel_intent_delivery` (`order_delivery_id`),
  KEY `idx_delivery_cancel_intent_status` (`status`, `state_entered_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 취소 durable intent + 환불 재조정 원장';

-- 재조정 대상
-- SELECT * FROM delivery_cancel_intent
--  WHERE status IN ('PENDING','CANCEL_CONFIRMED','DB_APPLIED','RECONCILING');
