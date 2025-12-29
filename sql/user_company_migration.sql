-- ================================================
-- user_company 테이블 마이그레이션
-- 실행 순서: 1. 테이블 생성 -> 2. 데이터 마이그레이션 -> 3. user 테이블 FK 추가
-- ================================================

-- ================================================
-- 1단계: user_company 테이블 생성
-- ================================================
CREATE TABLE IF NOT EXISTS `user_company` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `business_name` VARCHAR(100) NOT NULL COMMENT '사업자명',
  `business_number` VARCHAR(100) NOT NULL COMMENT '사업자등록번호',
  `business_address` VARCHAR(255) NULL COMMENT '사업자주소',
  `business_phone_number` VARCHAR(50) NULL COMMENT '사업자연락처',
  `industry_type` VARCHAR(100) NULL COMMENT '업태',
  `industry_item` VARCHAR(100) NULL COMMENT '종목',
  `settle_method` VARCHAR(100) NULL COMMENT '정산방법',
  `maximum_limit` BIGINT NOT NULL DEFAULT 0 COMMENT '여신 한도',
  `bank_name` VARCHAR(100) NULL COMMENT '은행명',
  `bank_number` VARCHAR(100) NULL COMMENT '계좌번호',
  `card_name` VARCHAR(100) NULL COMMENT '카드사명',
  `card_number` VARCHAR(100) NULL COMMENT '카드번호',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UK_user_company_business_number` (`business_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ================================================
-- 2단계: user 테이블에 company_id 컬럼 추가
-- ================================================
ALTER TABLE `user`
ADD COLUMN `company_id` BIGINT NULL COMMENT 'FK) user_company.id' AFTER `id`;

-- ================================================
-- 3단계: 기존 데이터 마이그레이션 - user_company 생성
-- business_number 기준으로 그룹핑하여 회사 데이터 생성
-- maximum_limit은 MAX 값, 나머지는 대표 계정(is_head_person=true 우선) 값 사용
-- ================================================
INSERT INTO `user_company` (
  `business_name`,
  `business_number`,
  `business_address`,
  `business_phone_number`,
  `industry_type`,
  `industry_item`,
  `settle_method`,
  `maximum_limit`,
  `bank_name`,
  `bank_number`,
  `card_name`,
  `card_number`,
  `created_at`,
  `updated_at`
)
SELECT
  sub.business_name,
  sub.business_number,
  sub.business_address,
  sub.business_phone_number,
  sub.industry_type,
  sub.industry_item,
  sub.settle_method,
  sub.max_limit,
  sub.bank_name,
  sub.bank_number,
  sub.card_name,
  sub.card_number,
  NOW(),
  NOW()
FROM (
  SELECT
    u.business_number,
    -- 대표 계정(is_head_person=true) 우선, 없으면 가장 오래된 계정
    FIRST_VALUE(u.business_name) OVER (
      PARTITION BY u.business_number
      ORDER BY u.is_head_person DESC, u.id ASC
    ) AS business_name,
    FIRST_VALUE(u.business_address) OVER (
      PARTITION BY u.business_number
      ORDER BY u.is_head_person DESC, u.id ASC
    ) AS business_address,
    FIRST_VALUE(u.business_phone_number) OVER (
      PARTITION BY u.business_number
      ORDER BY u.is_head_person DESC, u.id ASC
    ) AS business_phone_number,
    FIRST_VALUE(u.industry_type) OVER (
      PARTITION BY u.business_number
      ORDER BY u.is_head_person DESC, u.id ASC
    ) AS industry_type,
    FIRST_VALUE(u.industry_item) OVER (
      PARTITION BY u.business_number
      ORDER BY u.is_head_person DESC, u.id ASC
    ) AS industry_item,
    FIRST_VALUE(u.settle_method) OVER (
      PARTITION BY u.business_number
      ORDER BY u.is_head_person DESC, u.id ASC
    ) AS settle_method,
    FIRST_VALUE(u.bank_name) OVER (
      PARTITION BY u.business_number
      ORDER BY u.is_head_person DESC, u.id ASC
    ) AS bank_name,
    FIRST_VALUE(u.bank_number) OVER (
      PARTITION BY u.business_number
      ORDER BY u.is_head_person DESC, u.id ASC
    ) AS bank_number,
    FIRST_VALUE(u.card_name) OVER (
      PARTITION BY u.business_number
      ORDER BY u.is_head_person DESC, u.id ASC
    ) AS card_name,
    FIRST_VALUE(u.card_number) OVER (
      PARTITION BY u.business_number
      ORDER BY u.is_head_person DESC, u.id ASC
    ) AS card_number,
    -- maximum_limit은 해당 사업자번호 중 최대값
    MAX(u.maximum_limit) OVER (PARTITION BY u.business_number) AS max_limit,
    ROW_NUMBER() OVER (PARTITION BY u.business_number ORDER BY u.id) AS rn
  FROM `user` u
  WHERE u.business_number IS NOT NULL
    AND u.business_number != ''
    AND u.deleted_at IS NULL
) sub
WHERE sub.rn = 1;

-- ================================================
-- 4단계: user.company_id 업데이트
-- (COLLATE 추가: user 테이블과 user_company 테이블의 collation 불일치 해결)
-- ================================================
UPDATE `user` u
INNER JOIN `user_company` uc ON u.business_number COLLATE utf8mb4_unicode_ci = uc.business_number
SET u.company_id = uc.id
WHERE u.business_number IS NOT NULL
  AND u.business_number != '';

-- ================================================
-- 5단계: FK 제약조건 추가 (선택사항 - 운영 환경에 따라 결정)
-- ================================================
ALTER TABLE `user`
ADD CONSTRAINT `FK_user_company_id`
FOREIGN KEY (`company_id`) REFERENCES `user_company`(`id`);

-- ================================================
-- 검증 쿼리
-- ================================================
-- 마이그레이션 후 확인용 쿼리

-- 1. user_company 생성 개수 확인
SELECT COUNT(*) AS company_count FROM user_company;

-- 2. user.company_id 연결 확인
SELECT
  COUNT(*) AS total_users,
  SUM(CASE WHEN company_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_users,
  SUM(CASE WHEN company_id IS NULL THEN 1 ELSE 0 END) AS unlinked_users
FROM user
WHERE deleted_at IS NULL;

-- 3. 동일 회사 계정 확인
SELECT
  uc.id AS company_id,
  uc.business_number,
  uc.business_name,
  COUNT(u.id) AS user_count
FROM user_company uc
LEFT JOIN user u ON uc.id = u.company_id
GROUP BY uc.id, uc.business_number, uc.business_name
HAVING COUNT(u.id) > 1
ORDER BY user_count DESC;

-- ================================================
-- 6단계: user 테이블에서 중복 컬럼 삭제 (마이그레이션 완료 후 실행)
-- 주의: 데이터 마이그레이션 확인 후 실행할 것!
-- ================================================
ALTER TABLE `user`
DROP COLUMN `business_number`,
DROP COLUMN `business_name`,
DROP COLUMN `business_address`,
DROP COLUMN `business_phone_number`,
DROP COLUMN `industry_type`,
DROP COLUMN `industry_item`;