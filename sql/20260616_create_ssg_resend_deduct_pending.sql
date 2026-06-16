-- SSG 재발급 선차감 durable pending 마커 (crash 복구).
-- wip4: deductEventBalance 커밋 후 issue() 전/중 크래시 시 선차감 leak 을 sweep 으로 자동 수렴시키기 위한 테이블.
--
-- 신규 additive 테이블 → 구버전 코드 무해, 배포 전/후 무관하게 안전.
-- sweep 시간격리는 기존 SSG 복구 sweep 과 동일하게 SSG_SWEEP_MIGRATION_AT 환경변수를 공유한다.

CREATE TABLE `ssg_resend_deduct_pending` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `resend_deduction_id` VARCHAR(26) NOT NULL COMMENT 'ulid. refundResendEventDeduction 역복원 멱등키와 동일',
  `ssg_event_id` INT NOT NULL COMMENT '선차감된 신규 행사 id',
  `order_id` INT NOT NULL,
  `amount` INT NOT NULL COMMENT '선차감액(= product.price)',
  `purpose` VARCHAR(20) NOT NULL COMMENT 'BATCH_RESEND | CS_REISSUE',
  `issue_order_delivery_id` INT NULL COMMENT 'issue() 대상 delivery. CS 는 신규 delivery 저장 후 set',
  `issue_attempted_at` DATETIME(6) NULL COMMENT 'issue() 직전 set. NULL=외부 미등록 확정(W1)',
  `resolved_at` DATETIME(6) NULL COMMENT 'KEPT/REVERSED 확정 시각. sweep 후보=NULL',
  `resolution` VARCHAR(20) NULL COMMENT 'KEPT | REVERSED',
  `recover_token` VARCHAR(26) NULL COMMENT 'sweep CAS lease 토큰',
  `recover_lease_until` DATETIME(6) NULL,
  `recover_attempts` INT NOT NULL DEFAULT 0,
  `recover_escalated_at` DATETIME(6) NULL COMMENT '단발 escalation 가드',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY `uk_ssg_resend_pending_deduction_id` (`resend_deduction_id`),
  KEY `idx_ssg_resend_pending_sweep` (`resolved_at`, `recover_lease_until`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
