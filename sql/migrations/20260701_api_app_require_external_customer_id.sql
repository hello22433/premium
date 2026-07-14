-- 외부 API: 매핑 필수 모드 플래그 (api_app.require_external_customer_id)
-- ============================================================================
-- 목적:
--   플랫폼형 계정(1키 → N billing 계정, 예: WiseAd)에서 externalCustomerId 없는
--   상품조회/주문이 default(외부서비스용 계정)로 조용히 청구되는 것을 차단한다.
--   true 이면 resolveBillingTarget 이 externalCustomerId 미지정/공백 요청을 2001 로 거절.
--
-- 설계 근거: plans/2026-07-01-external-api-require-mapping-mode.md (APPROVED).
--   - 기본값 false → 기존 단순모드 계정(Club 포함) 동작 100% 보존(회귀 없음).
--   - 재발급/회전 시 값 유지(코드에서 preserve) — 키 회전이 청구 규약을 바꾸면 안 됨.
--   - app 전용 플래그(legacy external_api_account 에는 두지 않음).
--
-- 제약: additive only (컬럼 추가). 기존 컬럼/관계/로직 제거 없음.
--       PHASE(무중단): OLD 코드는 신규 컬럼을 읽지 않으므로 그대로 추가 가능.
-- 환경: MySQL 8.4 / ENGINE=InnoDB / utf8mb4.
-- ============================================================================

ALTER TABLE `api_app`
  ADD COLUMN `require_external_customer_id` TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '매핑 필수 모드(true=externalCustomerId 없는 상품조회/주문 거절)' AFTER `cancel_webhook_enabled`;

-- 검증
-- SHOW COLUMNS FROM `api_app` LIKE 'require_external_customer_id';
-- 기존 행 전부 0(false) 확인: SELECT COUNT(*) FROM api_app WHERE require_external_customer_id <> 0;  -- 기대 0

-- 롤백 (코드 롤백 후에만)
-- ALTER TABLE `api_app` DROP COLUMN `require_external_customer_id`;
