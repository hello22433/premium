-- 외부 API 쿠폰 폐기 통보 Webhook
-- 외부 고객사가 자신이 발급받은 쿠폰의 폐기/취소를 실시간으로 통보받을 수 있도록
-- (1) external_api_account에 webhook URL/활성화 플래그 추가
-- (2) 호출 이력을 적재할 external_api_webhook_log 테이블 신규 생성

-- 1. external_api_account 컬럼 추가
ALTER TABLE external_api_account
  ADD COLUMN cancel_webhook_url     VARCHAR(512) NULL                COMMENT '폐기 통보 수신 URL (HTTPS만 허용, NULL=비활성)' AFTER resend_max_count,
  ADD COLUMN cancel_webhook_enabled TINYINT(1)   NOT NULL DEFAULT 0  COMMENT 'webhook 활성화 토글 (URL과 별개로 일시 중단 가능)' AFTER cancel_webhook_url;

-- 2. 호출 이력
CREATE TABLE external_api_webhook_log (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  external_api_account_id  BIGINT       NOT NULL COMMENT 'FK) external_api_account.id',
  order_delivery_id        BIGINT       NULL     COMMENT 'FK) order_delivery.id (추적용)',
  event_type               VARCHAR(32)  NOT NULL COMMENT '이벤트 종류 (현재 COUPON_CANCEL만)',
  event_id                 VARCHAR(64)  NOT NULL COMMENT '이벤트 UUID (외부 중복 식별용)',
  request_url              VARCHAR(512) NOT NULL COMMENT '발송 시점의 URL 스냅샷',
  request_body             TEXT         NOT NULL COMMENT 'JSON 페이로드',
  response_status          INT          NULL     COMMENT 'HTTP status (네트워크 실패 시 NULL)',
  response_body            TEXT         NULL     COMMENT '응답 본문 (최대 2KB 절단)',
  error_message            TEXT         NULL     COMMENT '예외 메시지 (실패 시)',
  is_success               TINYINT(1)   NOT NULL COMMENT '2xx 여부',
  response_time_ms         INT          NULL     COMMENT '소요 시간 (ms)',
  created_at               DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  KEY idx_external_api_webhook_log_account  (external_api_account_id, created_at),
  KEY idx_external_api_webhook_log_delivery (order_delivery_id),
  KEY idx_external_api_webhook_log_event    (event_id)
) COMMENT='외부 API webhook 호출 이력';
