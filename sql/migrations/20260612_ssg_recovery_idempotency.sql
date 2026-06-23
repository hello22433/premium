-- SSG 행사 잔액 복구(refundForDeliveryFail) 멱등화.
-- docs/plans/2026-06-12-external-api-wallet-integration.md B-4/B-6.
--
-- 1) order_delivery_refund 에 후속 lease/sweep 용 컬럼 추가 (이번 단계는 스키마만, 사용 안 함).
-- 2) ssg_event_recovery_log: refund_ledger_id(= order_delivery_refund.id) UNIQUE 로
--    동일 ledger row 의 두 번째 복구 시도를 DB 차원에서 차단(멱등키). INSERT 가 ER_DUP_ENTRY 면
--    이미 복구된 것 → 잔액 미변경 return.

ALTER TABLE order_delivery_refund
  ADD COLUMN ssg_recover_token        VARCHAR(26)  NULL                COMMENT '후속 lease/token 용 (이번 단계 미사용)',
  ADD COLUMN ssg_recover_lease_until  DATETIME(6)  NULL                COMMENT '후속 lease 만료 (이번 단계 미사용)',
  ADD COLUMN ssg_recover_attempts     INT          NOT NULL DEFAULT 0  COMMENT '후속 sweep 재시도 횟수 (이번 단계 미사용)',
  ADD COLUMN ssg_recover_escalated_at DATETIME(6)  NULL                COMMENT '후속 sweep 에스컬레이션 시각 (이번 단계 미사용)';

CREATE TABLE ssg_event_recovery_log (
  id                BIGINT      AUTO_INCREMENT PRIMARY KEY,
  refund_ledger_id  BIGINT      NOT NULL                COMMENT 'FK) order_delivery_refund.id (멱등키)',
  ssg_event_id      INT         NOT NULL                COMMENT 'FK) ssg_event.id',
  order_id          INT         NOT NULL                COMMENT 'FK) order.id',
  amount            INT         NOT NULL                COMMENT '복구된 행사 잔액 금액',
  applied_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  UNIQUE KEY uk_ssg_event_recovery_ledger (refund_ledger_id)
) COMMENT='SSG 행사 잔액 복구 멱등 로그 (refund_ledger_id UNIQUE = 이중 복구 차단)';
