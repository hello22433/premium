-- External API Migration
-- 실행 시점: 외부 API 기능 배포 전

-- 1. user 테이블에 api_key_hash 컬럼 추가
ALTER TABLE `user` ADD COLUMN `api_key_hash` VARCHAR(64) NULL UNIQUE
  COMMENT '외부 API 키 (SHA-256 해시)' AFTER `authority_list`;

-- 2. order_delivery 테이블: external_tr_id 컬럼 제거 (사용하지 않음)
-- 이미 적용된 환경에서만 실행
-- ALTER TABLE `order_delivery` DROP INDEX `idx_order_delivery_external_tr_id`;
-- ALTER TABLE `order_delivery` DROP COLUMN `external_tr_id`;

-- 3. order 테이블에 type 인덱스 추가 (외부주문 조회 성능)
ALTER TABLE `order` ADD INDEX `idx_order_type` (`type`);

-- 4. order_delivery.transaction_id 인덱스 추가 (외부 API trId 조회)
ALTER TABLE `order_delivery` ADD INDEX `idx_order_delivery_transaction_id` (`transaction_id`);

-- 5. idempotency_keys 테이블 생성
CREATE TABLE `idempotency_keys` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `idempotency_key` VARCHAR(64) NOT NULL COMMENT '멱등키',
  `user_id` INT NOT NULL COMMENT 'FK) user.id (API Key 소유자)',
  `endpoint` VARCHAR(200) NOT NULL COMMENT 'API 엔드포인트',
  `request_hash` VARCHAR(64) NOT NULL COMMENT '요청 바디 해시 (SHA-256)',
  `status` ENUM('PROCESSING', 'COMPLETE') NOT NULL DEFAULT 'PROCESSING',
  `response_body` JSON NULL COMMENT '캐싱된 응답',
  `response_status` INT NULL COMMENT '캐싱된 HTTP 상태 코드',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME NOT NULL COMMENT '만료 시각',
  PRIMARY KEY (`id`),
  UNIQUE INDEX `idx_idempotency_unique` (`idempotency_key`, `user_id`, `endpoint`),
  INDEX `idx_idempotency_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='외부 API 멱등성 키 관리';
