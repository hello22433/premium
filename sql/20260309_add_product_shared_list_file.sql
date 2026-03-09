CREATE TABLE `product_shared_list_file` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL COMMENT 'FK) user.id, 업로드한 관리자 id',
  `file_name` VARCHAR(255) NOT NULL COMMENT '원본 파일명',
  `file_url` VARCHAR(500) NOT NULL COMMENT '업로드 파일 url',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_product_shared_list_file_user_id` (`user_id`),
  KEY `idx_product_shared_list_file_deleted_at` (`deleted_at`),
  KEY `idx_product_shared_list_file_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='고객사 다운로드용 상품리스트 업로드 파일';
