-- 개발지원요청(Requirement) 기능 테이블 생성
-- 프로덕션 환경은 DATABASE_SYNCHRONIZE="false"이므로 수동 마이그레이션 필요
-- TypeORM SnakeNamingStrategy 기준 snake_case 컬럼명 사용
-- createForeignKeyConstraints: false → FK 제약조건 없음

-- 1) requirement (개발지원요청)
CREATE TABLE IF NOT EXISTS `requirement` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL COMMENT 'FK) user.id, 등록한 관리자 id',
  `title` VARCHAR(100) NOT NULL COMMENT '제목',
  `type` VARCHAR(50) NOT NULL COMMENT '유형 ex) NEW_FEATURE: 신규기능, MODIFICATION: 수정, BUG: 버그',
  `related_page` VARCHAR(200) NULL COMMENT '관련 페이지',
  `priority` VARCHAR(50) NOT NULL COMMENT '우선순위 ex) URGENT: 긴급, HIGH: 높음, NORMAL: 보통',
  `content` TEXT NOT NULL COMMENT '상세 내용',
  `status` VARCHAR(50) NOT NULL DEFAULT 'NEW' COMMENT '상태 ex) NEW: 신규, REVIEW: 검토중, IN_PROGRESS: 진행중, COMPLETE: 완료',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) requirement_comment (개발지원요청 댓글)
CREATE TABLE IF NOT EXISTS `requirement_comment` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `requirement_id` INT NOT NULL COMMENT 'FK) requirement.id',
  `user_id` INT NOT NULL COMMENT 'FK) user.id, 댓글 작성자 id',
  `content` TEXT NOT NULL COMMENT '댓글 내용',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) requirement_attachment (개발지원요청 첨부파일)
CREATE TABLE IF NOT EXISTS `requirement_attachment` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `requirement_id` INT NOT NULL COMMENT 'FK) requirement.id',
  `file_url` VARCHAR(500) NOT NULL COMMENT '파일 URL',
  `file_name` VARCHAR(200) NOT NULL COMMENT '파일명',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 검증 쿼리
-- SHOW TABLES LIKE 'requirement%';
