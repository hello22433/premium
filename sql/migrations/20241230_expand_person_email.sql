-- Migration: Expand person_email column for multiple emails and add user_id to email_send_history
-- Date: 2024-12-30
-- Description:
--   1. person_email 컬럼을 확장하여 쉼표 구분으로 여러 담당자 이메일 저장 가능하도록 변경
--   2. email_send_history에 user_id 컬럼 추가하여 계정별 로그인 인증 이력 관리

-- Step 1: person_email 컬럼 확장 (varchar 100 → varchar 500)
ALTER TABLE `user` MODIFY COLUMN `person_email` VARCHAR(500) NOT NULL COMMENT '담당자 이메일 (쉼표 구분으로 여러 개 저장 가능)';

-- Step 2: email_send_history에 user_id 컬럼 추가
ALTER TABLE `email_send_history` ADD COLUMN `user_id` INT NULL COMMENT '사용자 ID (로그인 인증용)' AFTER `order_delivery_id`;

-- Step 3: user_id 인덱스 추가
CREATE INDEX `idx_email_send_history_user_id` ON `email_send_history` (`user_id`);

-- Step 4: ip 컬럼 구분자 변경 (:: → ,)
-- 기존 데이터에서 '::' 구분자를 ','로 변경
UPDATE `user` SET `ip` = REPLACE(`ip`, '::', ',') WHERE `ip` LIKE '%::%';
