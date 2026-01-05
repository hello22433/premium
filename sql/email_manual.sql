CREATE TABLE `email_manual` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `content` TEXT NOT NULL COMMENT '이메일 사용방법 내용',
    `user_id` INT NOT NULL COMMENT '작성/수정한 사용자 ID',
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    `deleted_at` DATETIME(6) NULL,
    PRIMARY KEY (`id`),
    KEY `FK_email_manual_user` (`user_id`),
    CONSTRAINT `FK_email_manual_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='이메일 사용방법 기본값';
