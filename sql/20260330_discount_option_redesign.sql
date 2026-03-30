-- 할인 옵션 재설계 마이그레이션
-- 실행 전 반드시 백업할 것
-- 실행 순서: DB 마이그레이션 → 백엔드 배포

-- 1. classificationId 컬럼 추가
ALTER TABLE user_discount ADD COLUMN classification_id INT NULL COMMENT 'FK) classification.id 카테고리';

-- 2. category enum 변경 (3단계 ALTER-UPDATE-ALTER)
-- 2a. 모든 값 포함하도록 확장
ALTER TABLE user_discount MODIFY COLUMN category ENUM('CATEGORY','CLASSIFICATION','PRODUCT_GROUP','BRAND') NOT NULL;
-- 2b. 기존 값 변환
UPDATE user_discount SET category = 'PRODUCT_GROUP' WHERE category = 'CATEGORY';
UPDATE user_discount SET category = 'BRAND' WHERE category = 'CLASSIFICATION';
-- 2c. 구 값 제거, 신 CATEGORY 추가
ALTER TABLE user_discount MODIFY COLUMN category ENUM('PRODUCT_GROUP','CATEGORY','BRAND') NOT NULL;


-- ============================================================
-- 롤백 SQL (문제 발생 시)
-- ============================================================
-- ALTER TABLE user_discount MODIFY COLUMN category ENUM('PRODUCT_GROUP','CATEGORY','BRAND','CLASSIFICATION') NOT NULL;
-- UPDATE user_discount SET category = 'CATEGORY' WHERE category = 'PRODUCT_GROUP';
-- UPDATE user_discount SET category = 'CLASSIFICATION' WHERE category = 'BRAND';
-- ALTER TABLE user_discount MODIFY COLUMN category ENUM('CATEGORY','CLASSIFICATION') NOT NULL;
-- ALTER TABLE user_discount DROP COLUMN classification_id;
