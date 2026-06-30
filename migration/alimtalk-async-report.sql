-- 알림톡 발송/수신확인 분리 + 자동 재발송 1회 (ALIMTALK_ASYNC_REPORT)
-- 실행 시점: 코드 배포 전 (전부 backward-compatible: 신규 컬럼은 NULL/DEFAULT, 기존 행 영향 없음)

-- 1. order_delivery: 비동기 리포트 확인 / 자동 재발송 메타 컬럼
ALTER TABLE `order_delivery`
  ADD COLUMN `alim_talk_msg_key` VARCHAR(64) NULL COMMENT '알림톡 msgKey (수신리포트 inquiry 키)' AFTER `api_error_message`,
  ADD COLUMN `report_state` VARCHAR(20) NULL COMMENT '수신리포트 확인 상태 (NULL=비대상, PENDING/CONFIRMED/UNCONFIRMED)' AFTER `alim_talk_msg_key`,
  ADD COLUMN `report_deadline_at` DATETIME NULL COMMENT '리포트 확인 마감 시각 (미수신 영구대기 방지)' AFTER `report_state`,
  ADD COLUMN `report_attempt_count` INT NOT NULL DEFAULT 0 COMMENT '리포트 inquiry 누적 시도수' AFTER `report_deadline_at`,
  ADD COLUMN `report_fallback_attempt_count` INT NOT NULL DEFAULT 0 COMMENT 'SMS 폴백 자동 재발송 cap (resend_count 와 분리)' AFTER `report_attempt_count`,
  ADD COLUMN `report_next_due_at` DATETIME NULL COMMENT '다음 inquiry 수행 예정 시각 (30초 간격 근사)' AFTER `report_fallback_attempt_count`,
  ADD COLUMN `report_claimed_at` DATETIME(6) NULL COMMENT 'reportSweep 멱등 claim 시각 (lease 만료 판정용)' AFTER `report_next_due_at`,
  ADD COLUMN `report_owner_token` VARCHAR(64) NULL COMMENT 'reportSweep 회차 소유 토큰 (자기 토큰 행만 처리)' AFTER `report_claimed_at`;

-- 2. reportSweep claim 조회 인덱스 (report_state + report_next_due_at)
CREATE INDEX `idx_od_report_sweep` ON `order_delivery` (`report_state`, `report_next_due_at`);

-- 3. delivery_send_history: orderDelivery 연결키 (POST 성공 이력을 최종 결과로 정정)
ALTER TABLE `delivery_send_history`
  ADD COLUMN `order_delivery_id` INT NULL COMMENT 'FK) order_delivery.id (POST 성공 이력 최종결과 정정용)' AFTER `id`;
CREATE INDEX `idx_dsh_order_delivery_id` ON `delivery_send_history` (`order_delivery_id`);
