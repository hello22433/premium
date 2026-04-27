-- 외부 API 계정 SSG 활성화 요청 테이블
-- 본인이 SSG 사용 신청 → 어드민이 승인/거부.
-- 동일 account에 PENDING 요청은 1개만 허용 (앱 레이어 검증).
-- 비활성화는 어드민이 PATCH /api-keys/:accountId로 직접 전환 (요청 절차 없음).

CREATE TABLE external_api_ssg_request (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id            BIGINT       NOT NULL COMMENT 'FK) external_api_account.id',
  requested_by_user_id  INT          NOT NULL COMMENT 'FK) user.id (요청자)',
  reason                VARCHAR(500) NOT NULL COMMENT '요청 사유',
  status                ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  decided_by_user_id    INT          NULL     COMMENT 'FK) user.id (승인/거부 어드민)',
  decided_at            DATETIME(6)  NULL,
  decision_note         VARCHAR(500) NULL     COMMENT '승인/거부 사유',
  created_at            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  KEY idx_ssg_request_account (account_id, status),
  KEY idx_ssg_request_status (status, created_at)
) COMMENT='외부 API 계정 SSG 활성화 요청';
