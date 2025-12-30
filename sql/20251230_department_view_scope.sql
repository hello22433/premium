-- ================================================
-- 부서(department) 및 조회 범위(user_view_scope) 테이블 마이그레이션
-- 실행 순서: 1. department 테이블 생성 -> 2. user_view_scope 테이블 생성 -> 3. user 테이블에 department_id 추가
-- ================================================

-- ================================================
-- 1단계: department 테이블 생성
-- ================================================
CREATE TABLE IF NOT EXISTS `department` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` BIGINT NOT NULL COMMENT 'FK) user_company.id',
  `name` VARCHAR(100) NOT NULL COMMENT '부서명',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `FK_department_company_id` FOREIGN KEY (`company_id`) REFERENCES `user_company`(`id`),
  UNIQUE KEY `UK_department_company_name` (`company_id`, `name`, `deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ================================================
-- 2단계: user_view_scope 테이블 생성
-- scope_type 설명:
--   SELF: 본인 주문 + 본인에게 배정된 주문
--   DEPARTMENT: 같은 부서 주문 (dept_ids가 있으면 해당 부서들도 포함)
--   COMPANY: 같은 회사 전체 주문
--   ALL: 모든 주문 (SUPER_ADMIN용)
-- ================================================
CREATE TABLE IF NOT EXISTS `user_view_scope` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL COMMENT 'FK) user.id',
  `scope_type` ENUM('SELF', 'DEPARTMENT', 'COMPANY', 'ALL') NOT NULL DEFAULT 'SELF' COMMENT '조회 범위 타입',
  `dept_ids` VARCHAR(500) NULL COMMENT '추가 조회 가능 부서 ID 목록 (콤마 구분, DEPARTMENT 타입일 때 사용)',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  CONSTRAINT `FK_user_view_scope_user_id` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`),
  UNIQUE KEY `UK_user_view_scope_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ================================================
-- 3단계: user 테이블에 department_id 컬럼 추가
-- ================================================
ALTER TABLE `user`
ADD COLUMN `department_id` INT NULL COMMENT 'FK) department.id' AFTER `company_id`;

ALTER TABLE `user`
ADD CONSTRAINT `FK_user_department_id` FOREIGN KEY (`department_id`) REFERENCES `department`(`id`);

-- ================================================
-- 4단계: 기존 사용자에게 기본 view_scope 설정 (SELF)
-- SUPER_ADMIN은 ALL로 설정
-- ================================================
INSERT INTO `user_view_scope` (`user_id`, `scope_type`)
SELECT
  `id`,
  CASE
    WHEN `authority` = 'SUPER_ADMIN' THEN 'ALL'
    ELSE 'SELF'
  END
FROM `user`
WHERE `deleted_at` IS NULL;

-- ================================================
-- 검증 쿼리
-- ================================================

-- 1. department 테이블 생성 확인
SELECT COUNT(*) AS department_count FROM department;

-- 2. user_view_scope 생성 확인
SELECT
  scope_type,
  COUNT(*) AS count
FROM user_view_scope
GROUP BY scope_type;

-- 3. user.department_id 컬럼 확인
DESCRIBE user;
