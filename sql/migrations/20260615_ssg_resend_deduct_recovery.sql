-- SSG 재발송 선차감 역복원 멱등화.
-- 리뷰 HIGH: 재발송 새 행사 선차감 실패 시 역복원이 원래 환불 cycle 의 recovery_log(refund_ledger_id)
-- 키를 재사용해 충돌 → 실제 잔액 복원 없이 멱등 no-op 되는 leak 차단.
--
-- 재발송 선차감마다 발급하는 고유 resend_deduction_id(ULID) 를 멱등키로 사용하는 전용 테이블.
-- INSERT 가 ER_DUP_ENTRY 면 이미 역복원된 deduction → 잔액 미변경 return.

CREATE TABLE ssg_resend_deduct_recovery (
  id                  BIGINT      AUTO_INCREMENT PRIMARY KEY,
  resend_deduction_id VARCHAR(26) NOT NULL                COMMENT '재발송 선차감 단위 멱등키 (ULID)',
  ssg_event_id        INT         NOT NULL                COMMENT 'FK) ssg_event.id (역복원 대상 새 행사)',
  order_id            INT         NOT NULL                COMMENT 'FK) order.id',
  amount              INT         NOT NULL                COMMENT '역복원된 행사 잔액 금액',
  applied_at          DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  UNIQUE KEY uk_ssg_resend_deduct_recovery_id (resend_deduction_id)
) COMMENT='SSG 재발송 선차감 역복원 멱등 로그 (resend_deduction_id UNIQUE = 이중 역복원 차단)';
