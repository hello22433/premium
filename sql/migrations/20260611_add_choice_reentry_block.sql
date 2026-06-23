-- 초이스 쿠폰 재진입 차단 - order_delivery 컬럼 추가
-- 스펙: choice-coupon-reentry-block-backend.md
--
-- 신규 컬럼은 모두 nullable. 기존 행은 null 유지(legacy fallback 적용).
-- 기능 배포 이후 선택된 행은 choice_post_send_status 가 반드시
-- NOT_REQUIRED / SENDING / SENT / FAILED 중 하나가 된다.
-- choice_post_send_status 는 추정 backfill 하지 않는다.

ALTER TABLE `order_delivery`
  -- 초이스 선택 후 별도 발송 상태
  ADD COLUMN `choice_post_send_status`        VARCHAR(20) NULL COMMENT '초이스 선택 후 별도 발송 상태 (NOT_REQUIRED/SENDING/SENT/FAILED). null=legacy',
  ADD COLUMN `choice_post_send_claim_token`   VARCHAR(64) NULL COMMENT '별도 발송 claim token (UUID)',
  ADD COLUMN `choice_post_send_claimed_at`    DATETIME(6) NULL COMMENT '별도 발송 claim 획득 시각 (stale 판정용)',
  ADD COLUMN `choice_post_sent_at`            DATETIME(6) NULL COMMENT '별도 쿠폰 이미지 발송 성공 시각',
  -- 초이스 선택 자체 중복 실행 방지 claim
  ADD COLUMN `choice_selection_claim_token`            VARCHAR(64) NULL COMMENT '선택 claim token (UUID)',
  ADD COLUMN `choice_selection_claimed_at`             DATETIME(6) NULL COMMENT '선택 claim 획득 시각',
  ADD COLUMN `choice_selection_attempt_key`            VARCHAR(64) NULL COMMENT '공급사 멱등 발급/조회용 안정 attempt key',
  ADD COLUMN `choice_selection_reconcile_required_at`  DATETIME(6) NULL COMMENT '선택 PIN 발급 결과 불명 → 운영 reconcile 필요',
  -- EMAIL 쿠폰 발송 동시성 claim
  ADD COLUMN `email_coupon_claim_token`            VARCHAR(64) NULL COMMENT 'EMAIL 쿠폰 발송 claim token (UUID)',
  ADD COLUMN `email_coupon_claimed_at`             DATETIME(6) NULL COMMENT 'EMAIL 쿠폰 발송 claim 획득 시각',
  ADD COLUMN `email_coupon_attempt_key`            VARCHAR(64) NULL COMMENT 'EMAIL PIN 발급 멱등/조회용 안정 attempt key',
  ADD COLUMN `email_coupon_reconcile_required_at`  DATETIME(6) NULL COMMENT 'EMAIL PIN 발급 결과 불명 → 운영 reconcile 필요';
