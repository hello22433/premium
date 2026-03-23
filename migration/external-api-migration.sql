-- External API Migration
-- 실행 시점: 외부 API 기능 배포 전

-- 1. user 테이블에 api_key_hash 컬럼 추가
ALTER TABLE `user` ADD COLUMN `api_key_hash` VARCHAR(64) NULL UNIQUE
  COMMENT '외부 API 키 (SHA-256 해시)' AFTER `authority_list`;

-- 2. order_delivery 테이블에 transaction_id unique index 추가
-- 기존 배치 생성 transactionId는 UUID 기반이므로 충돌 없음
ALTER TABLE `order_delivery` ADD UNIQUE INDEX `idx_order_delivery_transaction_id` (`transaction_id`);

-- 3. order 테이블에 type 인덱스 추가 (외부주문 조회 성능)
ALTER TABLE `order` ADD INDEX `idx_order_type` (`type`);
