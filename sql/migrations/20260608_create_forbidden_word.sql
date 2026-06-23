-- 금칙어 자동차단 — 테이블 3종 생성 + 초기 시드
-- forbidden_word / forbidden_word_history / forbidden_word_block_log

-- ===========================================================================
-- 1. 금칙어 목록
-- ===========================================================================
CREATE TABLE `forbidden_word` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `word` varchar(100) NOT NULL COMMENT '금칙어 (완전일치 대상)',
  `category` varchar(50) DEFAULT NULL COMMENT '분류 (욕설/성적/대출/도박/유흥 등)',
  `is_active` tinyint(1) NOT NULL DEFAULT '1' COMMENT '활성 여부 (1: 활성, 0: 비활성)',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '생성일',
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '수정일',
  `deleted_at` datetime(6) DEFAULT NULL COMMENT '삭제일',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_word` (`word`),
  KEY `idx_is_active` (`is_active`),
  KEY `idx_category` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='금칙어 목록';

-- ===========================================================================
-- 2. 금칙어 변경 이력 (누가/언제/추가or삭제/이유)
-- ===========================================================================
CREATE TABLE `forbidden_word_history` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `word` varchar(100) NOT NULL COMMENT '대상 단어 (스냅샷, 삭제 후에도 이력 보존)',
  `action` varchar(10) NOT NULL COMMENT '변경 종류 (ADD, UPDATE, DELETE)',
  `reason` varchar(500) DEFAULT NULL COMMENT '변경 사유',
  `changed_by_user_id` int NOT NULL COMMENT '변경자 user.id',
  `changed_by_email` varchar(100) NOT NULL COMMENT '변경자 이메일 (스냅샷)',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '변경 시각',
  PRIMARY KEY (`id`),
  KEY `idx_word` (`word`),
  KEY `idx_changed_by_email` (`changed_by_email`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='금칙어 변경 이력';

-- ===========================================================================
-- 3. 금칙어 차단 로그
-- ===========================================================================
CREATE TABLE `forbidden_word_block_log` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int NOT NULL COMMENT '차단당한 작성자 user.id',
  `user_email` varchar(100) NOT NULL COMMENT '작성자 이메일 (스냅샷)',
  `matched_words` json NOT NULL COMMENT '적발된 금칙어 배열',
  `field` varchar(50) NOT NULL COMMENT '적발 필드 (sendContent 등)',
  `content_snippet` varchar(500) NOT NULL COMMENT '적발 내용 일부 (절단)',
  `order_id` int DEFAULT NULL COMMENT '연관 임시주문 order.id (있으면)',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '생성일',
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_user_email` (`user_email`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='금칙어 차단 로그';

-- ===========================================================================
-- 4. 초기 시드 (욕설/성적/대출/도박/유흥 등)
-- ===========================================================================
INSERT INTO `forbidden_word` (`word`, `category`, `is_active`) VALUES
  ('시발', '욕설', 1),
  ('씨발', '욕설', 1),
  ('새끼', '욕설', 1),
  ('병신', '욕설', 1),
  ('지랄', '욕설', 1),
  ('섹스', '성적', 1),
  ('성인용품', '성적', 1),
  ('출장', '유흥', 1),
  ('안마', '유흥', 1),
  ('대출', '대출', 1),
  ('카지노', '도박', 1),
  ('경마', '도박', 1),
  ('바카라', '도박', 1),
  ('토토', '도박', 1);
