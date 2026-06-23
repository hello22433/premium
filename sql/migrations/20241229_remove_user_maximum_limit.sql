-- Migration: Remove maximum_limit column from user table
-- Date: 2024-12-29
-- Description: user 테이블의 maximum_limit 컬럼을 제거하고,
--              user_company 테이블의 maximum_limit를 사용하도록 변경

-- 주의: 실행 전 반드시 데이터 백업을 수행하세요

-- Step 1: user 테이블에서 maximum_limit 컬럼 제거
ALTER TABLE `user` DROP COLUMN `maximum_limit`;

-- Step 2: user_company.maximum_limit 컬럼 타입을 BIGINT에서 INT로 변경
-- (TypeORM이 BIGINT를 string으로 반환하는 문제 해결)
ALTER TABLE `user_company` MODIFY COLUMN `maximum_limit` INT NOT NULL DEFAULT 0 COMMENT '여신 한도';