-- PR2: 외부 API 3계층 매핑모드 (api_customer_mapping) + order 매핑 식별자 컬럼
-- ============================================================================
-- 목적:
--   PR2a(api_app/api_credential) 위에 "1키 → N billing 계정" 매핑모드를 추가한다.
--   (api_app_id, external_customer_id) → billing_user_id 매핑 테이블 신규 생성 +
--   order 에 external_order_id / external_customer_id 컬럼 추가(매핑모드 추적/멱등 보조).
--
-- 설계 근거: ralplan PR2 최종(stage_n=7) Phase 1.
--   확정1: 매핑 타겟 = billingUserId 단일(company→대표 user resolve, wallet 은 settlement_code).
--   확정2: 매핑 유니크 = (api_app_id, external_customer_id), 전역 아님(api_app 내).
--   확정3: order external_order_id unique = (api_app_id, external_order_id), 전역 아님.
--   확정4: 미등록 external_customer_id → 코드에서 4xx(default fallback 금지).
--   확정5: 기존 external_api_account → default 매핑 자동이전은 "코드 fallback"으로 처리
--          (external_customer_id 미전송 → default billing). 매핑테이블 sentinel 행 미생성(M2 no-op).
--
-- ⚠️ MEDIUM-2(active-only unique) 근거:
--   소프트삭제(deleted_at IS NOT NULL) 후 동일 (api_app_id, external_customer_id) 재등록을
--   허용해야 한다. 단순 UNIQUE(api_app_id, external_customer_id) 는 삭제행도 포함해 재등록을 막고,
--   대안 UNIQUE(api_app_id, external_customer_id, deleted_at) 는 MySQL 이 NULL 을 distinct 로
--   취급해 active(deleted_at=NULL) 중복을 막지 못한다(설계결함, 채택 금지).
--   → 생성 컬럼 active_key = CASE WHEN deleted_at IS NULL THEN external_customer_id ELSE NULL END
--     + UNIQUE(api_app_id, active_key) 로 고정. 삭제행은 active_key=NULL → 서로 충돌 안 함,
--     활성행은 동일 (api_app, external_customer_id) 차단.
--
-- 제약: 본 파일은 additive only (테이블/컬럼 추가). 기존 컬럼/관계/로직 제거 없음.
--       PHASE 1(무중단): OLD 코드는 신규 컬럼/테이블을 읽지 않으므로 그대로 추가 가능.
-- 환경: MySQL 8.4 / ENGINE=InnoDB / utf8mb4.
-- ============================================================================


-- ============================================================================
-- M1. 신규 테이블 생성: api_customer_mapping
-- ============================================================================
CREATE TABLE `api_customer_mapping` (
  `id`                   BIGINT       NOT NULL AUTO_INCREMENT,
  `api_app_id`           BIGINT       NOT NULL                COMMENT 'FK) api_app.id (외부 API 호출주체)',
  `external_customer_id` VARCHAR(191) NOT NULL                COMMENT '외부 고객 식별자 (api_app 내 유니크)',
  `billing_user_id`      INT          NOT NULL                COMMENT 'FK) user.id (매핑 차감대상 billing user)',
  -- active-only unique 보조: 활성행만 external_customer_id, 삭제행은 NULL.
  `active_key`           VARCHAR(191)
      GENERATED ALWAYS AS (CASE WHEN `deleted_at` IS NULL THEN `external_customer_id` ELSE NULL END) STORED
      COMMENT 'active-only unique 보조(삭제행 제외)',
  `created_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`           DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_api_customer_mapping_active` (`api_app_id`, `active_key`),
  KEY `idx_api_customer_mapping_app` (`api_app_id`),
  KEY `idx_api_customer_mapping_billing` (`billing_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='외부 API 3계층 매핑모드 (apiApp,externalCustomerId)->billingUser';

-- M1 검증
-- SHOW CREATE TABLE `api_customer_mapping`;
-- 활성 중복 차단 확인: 같은 (api_app_id, external_customer_id) 2행 INSERT → 2번째 uk 위반.
-- 삭제 후 재등록 확인: 1행 soft-delete(deleted_at SET) 후 동일값 INSERT → active_key 분리로 성공.

-- M1 롤백 (코드 롤백 후에만)
-- DROP TABLE IF EXISTS `api_customer_mapping`;


-- ============================================================================
-- M2. 백필: external_api_account → default 매핑 (no-op)
--   확정5: 기존 단순모드(키=계정 1:1)는 external_customer_id 미전송 → 코드 fallback 으로
--   default billing(api_app.default_billing_user_id) 사용. 매핑테이블에 sentinel 행을 만들지 않는다.
--   따라서 M2 는 의도적으로 no-op (기존 호출 100% 단순모드 유지, 회귀 0).
-- ============================================================================
-- (no-op)


-- ============================================================================
-- M3. order 컬럼 추가: external_order_id, external_customer_id (additive, nullable)
--   external_order_id: 매핑모드 비즈니스 멱등 보조. (api_app_id, external_order_id) 조건 유니크.
--     MySQL 은 unique 인덱스에서 NULL 을 distinct 로 취급 → 기존/단순모드 주문(NULL) 무영향.
--   external_customer_id: 매핑모드 추적/관찰성(Phase 8 상관 적재).
-- ============================================================================
ALTER TABLE `order`
  ADD COLUMN `external_order_id`    VARCHAR(191) NULL COMMENT '외부 주문번호 (매핑모드 멱등 보조, PR2)' AFTER `api_credential_id`,
  ADD COLUMN `external_customer_id` VARCHAR(191) NULL COMMENT '외부 고객 식별자 (매핑모드 추적, PR2)' AFTER `external_order_id`;

-- (api_app_id, external_order_id) 유니크: 같은 호출주체 내 동일 external_order_id 중복 주문 차단.
-- NULL 다중 허용이라 기존/단순모드 주문(external_order_id NULL) 무영향.
ALTER TABLE `order`
  ADD UNIQUE KEY `uk_order_api_app_external_order` (`api_app_id`, `external_order_id`);

-- M3 검증
-- SHOW CREATE TABLE `order`;
-- 같은 (api_app_id, external_order_id) 2행 → 2번째 uk 위반. NULL external_order_id 다중 → 허용.

-- M3 롤백 (코드 롤백 후에만)
-- ALTER TABLE `order` DROP INDEX `uk_order_api_app_external_order`;
-- ALTER TABLE `order` DROP COLUMN `external_customer_id`, DROP COLUMN `external_order_id`;
