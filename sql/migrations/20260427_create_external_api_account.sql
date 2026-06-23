-- 외부 API 계정 마스터 + IP 화이트리스트 + 상품 취소가능 플래그 + 재발송 카운터
-- 배경: 외부 고객사 API를 user.api_key_hash 단일 컬럼이 아닌 별도 계정 테이블로 분리
--       API 계정은 항상 user 단위로 발급. IP 화이트리스트·SSG 승인·재발송 한도를
--       계정 단위로 관리. 잔액 차감 분기는 user.company.balanceManagementType 그대로 사용
--
-- ⚠️ 운영 배포 절차 (반드시 순서 지킬 것)
--   1) 본 SQL 실행 전: 운영팀이 활성 외부 API 사용자별 호출 IP를 사전 수집
--   2) 본 SQL 실행 (기존 user.api_key_hash 보유자 → external_api_account로 이관)
--   3) 운영팀이 수집한 IP를 external_api_allowed_ip에 INSERT
--      ※ allowed_ip가 비어 있으면 신규 ApiKeyGuard가 모든 요청을 차단함
--   4) IP 등록 완료 검증 후 신규 코드 배포
--   5) ssg_enabled는 일괄 false로 시작. SSG 사용 계정은 운영팀이 별도 승인하여 true 전환
--   6) 안정화 후 별도 마이그레이션으로 user.api_key_hash 컬럼 DROP

-- 1. 외부 API 계정 마스터 (user 단위)
CREATE TABLE external_api_account (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id           INT          NOT NULL COMMENT 'FK) user.id',
  api_key_hash      VARCHAR(64)  NOT NULL COMMENT 'SHA-256(api_key)',
  is_active         TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '활성 여부',
  ssg_enabled       TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'SSG 주문 승인 여부',
  resend_max_count  INT          NULL     COMMENT '재발송 최대 횟수 (NULL=시스템 기본값)',
  created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  deleted_at        DATETIME(6)  NULL,

  UNIQUE KEY uk_external_api_account_key  (api_key_hash),
  UNIQUE KEY uk_external_api_account_user (user_id),
  KEY idx_external_api_account_active (is_active, deleted_at)
) COMMENT='외부 API 계정 마스터 (user 단위 발급)';

-- 2. IP 화이트리스트
CREATE TABLE external_api_allowed_ip (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id  BIGINT       NOT NULL COMMENT 'FK) external_api_account.id',
  ip_address  VARCHAR(45)  NOT NULL COMMENT '단일 IP (IPv4/IPv6)',
  description VARCHAR(100) NULL     COMMENT '용도 설명 (예: 본사 NAT, AWS prod)',
  created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  UNIQUE KEY uk_external_api_allowed_ip (account_id, ip_address),
  KEY idx_external_api_allowed_ip_account (account_id)
) COMMENT='외부 API 호출 허용 IP';

-- 3. 상품 취소 가능 플래그 (외부 API 취소 차단 정책용)
ALTER TABLE product
  ADD COLUMN is_cancelable TINYINT(1) NOT NULL DEFAULT 1 COMMENT '외부 API 주문 취소 가능 여부' AFTER use_status;

-- 4. 발송 건 재발송 카운터
ALTER TABLE order_delivery
  ADD COLUMN resend_count INT NOT NULL DEFAULT 0 COMMENT '외부 API 재발송 누적 횟수' AFTER resend_at;

-- 5. 기존 user.api_key_hash 보유자를 계정으로 이관
--    ※ allowed_ip는 비어 있으므로, 운영팀이 별도로 INSERT 해야 호출 가능
INSERT INTO external_api_account (user_id, api_key_hash, is_active, ssg_enabled)
SELECT id, api_key_hash, 1, 0
  FROM user
 WHERE api_key_hash IS NOT NULL
   AND deleted_at IS NULL;
