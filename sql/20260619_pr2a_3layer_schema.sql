-- PR2a: 외부 API 3계층 스키마 (api_app / api_credential) 도입 + 신구 병행 컬럼 추가
-- ============================================================================
-- 목적:
--   기존 external_api_account(=user 단위 단일 계정+키) 구조를
--   [api_app] (운영/과금 단위) - [api_credential] (키 회전 단위) 2계층으로 분리한다.
--   기존 external_api_* 테이블/order/idempotency_keys 에는 api_app_id(및 order는 api_credential_id)
--   를 nullable 로 추가해 신구 병행 운영(dual-write/dual-read)을 가능케 한다.
--
-- 설계 근거: ralplan §2(스키마 DDL M1~M7), §6(멱등 re-key), 결정1(credential/FK 귀속).
--
-- ⚠️ 운영 배포 절차 (반드시 순서 지킬 것)
--   [PHASE 1 · additive · 무중단 · OLD 코드 실행 중] M1~M6 + M7a 실행.
--     api_app/api_credential 생성 + 백필 + 모든 신규 컬럼(allowed_ip/webhook_log/ssg_request/order/
--     idempotency_keys 의 api_app_id, order.api_credential_id) ADD + 백필. 구 unique(idx_idempotency_unique)
--     유지 → OLD 코드(user_id 축 멱등) 무영향.
--   [PHASE 2 · quiesce] 503+Retry-After 진입 → in-flight PROCESSING 드레인 → S1 게이트(=0 확인) →
--     M7b(DROP idx_idempotency_unique → CREATE uq_idempotency) → **신규 코드 배포** → quiesce 해제.
--   [PR2c · 후속] 구 컬럼/관계(external_api_account.* / *_account_id / idempotency_keys.user_id) DROP.
--
-- ⚠️ MEDIUM-2 근거(코드 배포를 M7b 후 quiesce 안으로 이동한 이유):
--   신규 코드는 멱등 행을 apiAppId 로 조회/저장한다. M7b 전 구 unique=(idempotency_key,user_id,endpoint)
--   상태에서 신규 코드를 실행하면, 같은 default billing user 아래 복수 api_app 이 같은 key 를 쓸 때
--   구 unique 에 거짓 충돌(2005)이 난다(조회는 apiAppId 로 miss). 그래서 OLD 코드는 quiesce 로 드레인하고,
--   신규 코드는 M7b(신 unique=apiAppId 축) 후에만 배포한다 → "구-unique + 신-코드" 동시 구간을 제거한다.
--   (신규 코드는 항상 apiAppId 를 적재하므로 "api_app_id NULL + 신 unique" 구간도 발생하지 않는다.)
--   M6/M7a 컬럼은 PHASE 1 에서 이미 존재하므로 신규 코드 배포 시점엔 컬럼 존재 보장(HIGH-1 라운드 유지).
--
-- 제약: 본 파일은 additive only(컬럼/테이블 추가·백필). 기존 컬럼/관계/로직 제거 없음.
--       (단, M7b idempotency_keys 유니크 인덱스 재정의는 설계상 예외 — quiesce 후 실행.)
-- 환경: MySQL 8.4 / ENGINE=InnoDB / utf8mb4.
-- ============================================================================


-- ============================================================================
-- M1. 신규 테이블 생성: api_app, api_credential
-- ============================================================================

-- M1-1. api_app: 운영/과금 단위 (단순모드 차감대상 = default_billing_user_id)
CREATE TABLE `api_app` (
  `id`                       BIGINT       NOT NULL AUTO_INCREMENT,
  `default_billing_user_id`  INT          NOT NULL                COMMENT 'FK) user.id (단순모드 차감대상)',
  `source_account_id`        BIGINT       NULL                     COMMENT 'FK) external_api_account.id (account↔app 1:1 결정적)',
  `name`                     VARCHAR(100) NULL                    COMMENT '운영 식별',
  `is_active`                TINYINT(1)   NOT NULL DEFAULT 1,
  `ssg_enabled`              TINYINT(1)   NOT NULL DEFAULT 0       COMMENT 'SSG 주문 승인',
  `resend_max_count`         INT          NULL                    COMMENT '재발송 최대(NULL=시스템기본)',
  `cancel_webhook_url`       VARCHAR(512) NULL,
  `cancel_webhook_enabled`   TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`               DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`               DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`               DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  KEY `idx_api_app_default_billing_user` (`default_billing_user_id`),
  UNIQUE KEY `uk_api_app_source_account` (`source_account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='외부 API 운영/과금 단위 (api_app)';

-- M1-2. api_credential: API 키 회전 단위 (api_app 1:N credential)
CREATE TABLE `api_credential` (
  `id`            BIGINT       NOT NULL AUTO_INCREMENT,
  `api_app_id`    BIGINT       NOT NULL                COMMENT 'FK) api_app.id',
  `api_key_hash`  VARCHAR(64)  NOT NULL                COMMENT 'SHA-256(api_key)',
  `is_active`     TINYINT(1)   NOT NULL DEFAULT 1,
  `issued_at`     DATETIME     NOT NULL                COMMENT '발급일',
  `revoked_at`    DATETIME     NULL,
  `created_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`    DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_api_credential_key_hash` (`api_key_hash`),
  KEY `idx_api_credential_app` (`api_app_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='외부 API 자격증명(키) 회전 단위 (api_credential)';

-- M1 검증
-- SHOW CREATE TABLE `api_app`;
-- SHOW CREATE TABLE `api_credential`;

-- M1 롤백 (코드 롤백 후에만 실행, 생성 역순)
-- DROP TABLE IF EXISTS `api_credential`;
-- DROP TABLE IF EXISTS `api_app`;


-- ============================================================================
-- M2. 백필: external_api_account → api_app + api_credential
--     account 1행 → api_app 1행 + api_credential 1행.
--     account↔app 결정적 매핑은 api_app.source_account_id(=external_api_account.id, UNIQUE)로 영구 귀속.
--     ※ external_api_account.user_id 는 UNIQUE 아님(한 user 복수 account 가능) → 복수 api_app 정상.
--       매핑축을 source_account_id 로 고정해 account↔app 1:1 을 결정적으로 보장한다(HIGH-1).
-- ============================================================================

-- M2-1. account → api_app (1:1). source_account_id=acc.id 직접 설정.
--       deleted_at 포함 전이(소프트삭제 상태 보존).
INSERT INTO `api_app`
  (`source_account_id`, `default_billing_user_id`, `name`, `is_active`, `ssg_enabled`, `resend_max_count`,
   `cancel_webhook_url`, `cancel_webhook_enabled`, `created_at`, `updated_at`, `deleted_at`)
SELECT
  acc.`id`, acc.`user_id`, NULL, acc.`is_active`, acc.`ssg_enabled`, acc.`resend_max_count`,
  acc.`cancel_webhook_url`, acc.`cancel_webhook_enabled`, acc.`created_at`, acc.`updated_at`, acc.`deleted_at`
FROM `external_api_account` acc;

-- M2-2. account → api_credential (source_account_id 로 결정적 매핑).
--       api_key_hash 복사 / issued_at=account.created_at / revoked_at=account.deleted_at.
--       revoke(soft-delete) 계정은 is_active=0 정규화 + deleted_at 전이(가드 is_active 단독검사 회귀 방지).
INSERT INTO `api_credential`
  (`api_app_id`, `api_key_hash`, `is_active`, `issued_at`, `revoked_at`, `created_at`, `updated_at`, `deleted_at`)
SELECT
  aa.`id`, acc.`api_key_hash`,
  CASE WHEN acc.`deleted_at` IS NULL THEN acc.`is_active` ELSE 0 END,
  acc.`created_at`, acc.`deleted_at`, acc.`created_at`, acc.`updated_at`, acc.`deleted_at`
FROM `external_api_account` acc
JOIN `api_app` aa ON aa.`source_account_id` = acc.`id`;

-- M2 검증
-- 행수 일치: account 수 == api_app 수 == api_credential 수
-- SELECT (SELECT COUNT(*) FROM external_api_account) AS acc_cnt,
--        (SELECT COUNT(*) FROM api_app)              AS app_cnt,
--        (SELECT COUNT(*) FROM api_credential)       AS cred_cnt;
-- 매핑 결정성 검증(source_account_id 기준 1:1, 누락 0):
-- SELECT COUNT(*) FROM external_api_account acc
--   LEFT JOIN api_app aa ON aa.source_account_id = acc.id
--  WHERE aa.id IS NULL;  -- 0 이어야 함

-- M2 롤백 (코드 롤백 후에만 실행)
-- DELETE FROM `api_credential`;
-- DELETE FROM `api_app`;


-- ============================================================================
-- M3. external_api_allowed_ip: api_app_id 추가 + 백필 (구 account_id 유지)
-- ============================================================================
ALTER TABLE `external_api_allowed_ip`
  ADD COLUMN `api_app_id` BIGINT NULL COMMENT 'FK) api_app.id (PR2a 신구 병행)' AFTER `account_id`;

-- 백필: account_id → api_app.source_account_id 직접 매핑(결정적) → api_app_id
UPDATE `external_api_allowed_ip` ip
JOIN `api_app` aa ON aa.`source_account_id` = ip.`account_id`
SET ip.`api_app_id` = aa.`id`;

ALTER TABLE `external_api_allowed_ip`
  ADD INDEX `idx_external_api_allowed_ip_api_app` (`api_app_id`);

-- M3 검증
-- SHOW INDEX FROM `external_api_allowed_ip` WHERE Key_name = 'idx_external_api_allowed_ip_api_app';
-- SELECT COUNT(*) FROM external_api_allowed_ip WHERE api_app_id IS NULL;  -- 매핑 누락 점검(전부 백필 시 0)

-- M3 롤백 (코드 롤백 후에만 실행). 구 account_id 컬럼은 PR2c까지 유지.
-- ALTER TABLE `external_api_allowed_ip` DROP INDEX `idx_external_api_allowed_ip_api_app`;
-- ALTER TABLE `external_api_allowed_ip` DROP COLUMN `api_app_id`;


-- ============================================================================
-- M4. external_api_webhook_log: api_app_id 추가 + 백필 (구 external_api_account_id 유지)
-- ============================================================================
ALTER TABLE `external_api_webhook_log`
  ADD COLUMN `api_app_id` BIGINT NULL COMMENT 'FK) api_app.id (PR2a 신구 병행)' AFTER `external_api_account_id`;

-- 백필: external_api_account_id → api_app.source_account_id 직접 매핑(결정적) → api_app_id
UPDATE `external_api_webhook_log` wl
JOIN `api_app` aa ON aa.`source_account_id` = wl.`external_api_account_id`
SET wl.`api_app_id` = aa.`id`;

ALTER TABLE `external_api_webhook_log`
  ADD INDEX `idx_external_api_webhook_log_api_app` (`api_app_id`);

-- M4 검증
-- SHOW INDEX FROM `external_api_webhook_log` WHERE Key_name = 'idx_external_api_webhook_log_api_app';
-- SELECT COUNT(*) FROM external_api_webhook_log WHERE api_app_id IS NULL;

-- M4 롤백 (코드 롤백 후에만 실행)
-- ALTER TABLE `external_api_webhook_log` DROP INDEX `idx_external_api_webhook_log_api_app`;
-- ALTER TABLE `external_api_webhook_log` DROP COLUMN `api_app_id`;


-- ============================================================================
-- M5. external_api_ssg_request: api_app_id 추가 + 백필 (구 account_id 유지, requested_by_user_id 불변)
-- ============================================================================
ALTER TABLE `external_api_ssg_request`
  ADD COLUMN `api_app_id` BIGINT NULL COMMENT 'FK) api_app.id (PR2a 신구 병행)' AFTER `account_id`;

-- 백필: account_id → api_app.source_account_id 직접 매핑(결정적) → api_app_id
UPDATE `external_api_ssg_request` sr
JOIN `api_app` aa ON aa.`source_account_id` = sr.`account_id`
SET sr.`api_app_id` = aa.`id`;

ALTER TABLE `external_api_ssg_request`
  ADD INDEX `idx_external_api_ssg_request_api_app` (`api_app_id`);

-- M5 검증
-- SHOW INDEX FROM `external_api_ssg_request` WHERE Key_name = 'idx_external_api_ssg_request_api_app';
-- SELECT COUNT(*) FROM external_api_ssg_request WHERE api_app_id IS NULL;

-- M5 롤백 (코드 롤백 후에만 실행)
-- ALTER TABLE `external_api_ssg_request` DROP INDEX `idx_external_api_ssg_request_api_app`;
-- ALTER TABLE `external_api_ssg_request` DROP COLUMN `api_app_id`;


-- ============================================================================
-- M6. `order` (예약어→백틱): api_app_id + api_credential_id 추가
--     PHASE 1 · additive(ADD COLUMN nullable + ADD INDEX = 온라인). 기존 주문 backfill 없음(NULL 유지).
-- ============================================================================
ALTER TABLE `order`
  ADD COLUMN `api_app_id`        BIGINT NULL COMMENT 'FK) api_app.id (외부API 호출주체, PR2a)' AFTER `is_new_billing_flow`,
  ADD COLUMN `api_credential_id` BIGINT NULL COMMENT 'FK) api_credential.id (PR2a)'           AFTER `api_app_id`;

ALTER TABLE `order`
  ADD INDEX `idx_order_api_app` (`api_app_id`);

-- M6 검증
-- SHOW COLUMNS FROM `order` LIKE 'api_%';
-- SHOW INDEX FROM `order` WHERE Key_name = 'idx_order_api_app';

-- M6 롤백 (코드 롤백 후에만 실행, 추가 역순)
-- ALTER TABLE `order` DROP INDEX `idx_order_api_app`;
-- ALTER TABLE `order` DROP COLUMN `api_credential_id`;
-- ALTER TABLE `order` DROP COLUMN `api_app_id`;


-- ============================================================================
-- M7a. idempotency_keys: api_app_id 컬럼 추가 + 백필 (PHASE 1 · additive · 코드 배포 前)
--      유니크 재정의(M7b)는 PHASE 2(quiesce)로 분리. api_app_id 는 BIGINT(api_app.id 타입 정합).
-- ============================================================================
ALTER TABLE `idempotency_keys`
  ADD COLUMN `api_app_id` BIGINT NULL COMMENT 'FK) api_app.id (PR2a 멱등 re-key)' AFTER `user_id`;

-- 백필: user_id 가 정확히 api_app 1개에만 대응할 때만 매핑(N:1 모호행은 NULL 유지).
UPDATE `idempotency_keys` ik
JOIN (
  SELECT `default_billing_user_id` AS uid, MIN(`id`) AS app_id
    FROM `api_app`
   GROUP BY `default_billing_user_id`
  HAVING COUNT(*) = 1
) m ON m.uid = ik.`user_id`
SET ik.`api_app_id` = m.app_id;

-- M7a 검증
-- SHOW COLUMNS FROM `idempotency_keys` LIKE 'api_app_id';
-- SELECT COUNT(*) FROM idempotency_keys WHERE api_app_id IS NULL;  -- 모호/미매핑 행 수(참고용)


-- ====================== ⛔ PHASE 2 (quiesce · OLD 코드 상태에서 시작) ======================
-- 순서: OLD 코드 상태로 quiesce 진입 → S1 게이트 → M7b → 그 後 신규 코드 배포 → quiesce 해제.
-- (PHASE 1 에서 컬럼은 이미 존재. M7b 까지 OLD 코드 + 구 unique 로 동작; M7b 後 신규 코드 배포.)

-- S1. 필수 게이트 쿼리 (M7b 실행 직전에 반드시 실행)
--     userId 가 2+ api_app 에 대응(default_billing_user_id 중복)하는 in-flight idempotency 행 수.
--     결과가 0 이어야 uq_idempotency 적용이 안전하다. 0 이 아니면 M7b 중단 후 해당 user 멱등 흐름 정리.
-- SELECT COUNT(*) AS ambiguous_inflight
--   FROM idempotency_keys ik
--   JOIN (SELECT default_billing_user_id FROM api_app GROUP BY default_billing_user_id HAVING COUNT(*) > 1) dup
--     ON dup.default_billing_user_id = ik.user_id
--  WHERE ik.expires_at > NOW();

-- M7b. 멱등 유니크 재정의 (PHASE 2 · quiesce). (idempotency_key,user_id,endpoint) → (idempotency_key,api_app_id,endpoint).
--      ⛔ 사전조건: quiesce 진입 + S1 게이트 결과 = 0. user_id 컬럼은 전환기 보존(DROP 은 PR2c).
DROP INDEX `idx_idempotency_unique` ON `idempotency_keys`;
CREATE UNIQUE INDEX `uq_idempotency` ON `idempotency_keys` (`idempotency_key`, `api_app_id`, `endpoint`);

-- M7b 검증
-- SHOW INDEX FROM `idempotency_keys` WHERE Key_name IN ('uq_idempotency', 'idx_idempotency_unique');

-- M7a/M7b 롤백 (코드 롤백 후에만 실행, 추가 역순)
-- DROP INDEX `uq_idempotency` ON `idempotency_keys`;
-- CREATE UNIQUE INDEX `idx_idempotency_unique` ON `idempotency_keys` (`idempotency_key`, `user_id`, `endpoint`);
-- ALTER TABLE `idempotency_keys` DROP COLUMN `api_app_id`;


-- ============================================================================
-- 구 컬럼/관계(external_api_account.* / *_account_id / idempotency_keys.user_id) DROP 은
-- 신구 병행 안정화 후 PR2c 별도 마이그레이션으로 미룬다. 본 파일에서는 제거하지 않음.
-- ============================================================================
