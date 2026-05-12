-- 환불 ledger 테이블 (멱등성 락 전용)
-- 동일 order_delivery_id에 두 번 INSERT 시 UNIQUE 제약으로 두 번째 시도가 자동 차단된다.
-- 환불 메타데이터 audit는 ActivityLog/UserTaskHistory가 책임지고, ledger는 멱등성 보장 역할만 한다.
-- reverseRefundForResend(재발송 성공 시)는 row를 DELETE → 재실패 시 다시 INSERT 가능하도록 한다.

CREATE TABLE order_delivery_refund (
  id                  BIGINT       AUTO_INCREMENT PRIMARY KEY,
  order_delivery_id   INT          NOT NULL                COMMENT 'FK) order_delivery.id (UNIQUE = 멱등성 보장)',
  user_id             INT          NOT NULL                COMMENT '과금 대상 userId (대행 주문은 clientUserId)',
  refund_amount       INT          NOT NULL                COMMENT '환불 금액',
  restore_type        ENUM('BALANCE','COMPANY_BALANCE','ALL_SETTLE_AMOUNT') NOT NULL COMMENT '환불 적용 대상 (트레이스용)',
  is_settle_complete  TINYINT      NOT NULL                COMMENT '정산확정 후 환불 여부',
  is_settle_balance   TINYINT      NOT NULL                COMMENT '발송 시점 선입금 사용 여부',
  source_path         ENUM('CS_DISCARD','BATCH_FAIL','EXTERNAL_CANCEL','EXTERNAL_FAIL','ORDER_CANCEL') NOT NULL COMMENT '환불 호출 경로',
  operator_user_id    INT          NULL                    COMMENT '실행자 (시스템 처리 시 NULL)',
  memo                VARCHAR(255) NULL                    COMMENT '비고',
  refunded_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  UNIQUE KEY uk_order_delivery_refund_delivery (order_delivery_id),
  KEY idx_order_delivery_refund_user           (user_id, refunded_at),
  KEY idx_order_delivery_refund_path           (source_path, refunded_at)
) COMMENT='환불 멱등성 락 테이블 (동일 발송건 두 번 환불 차단)';
