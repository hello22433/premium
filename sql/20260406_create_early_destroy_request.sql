-- 조기 개인정보파기 요청 테이블
CREATE TABLE early_destroy_request (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT NOT NULL COMMENT 'FK) order.id',
  client_company VARCHAR(100) NULL COMMENT '고객사명',
  contact_person VARCHAR(100) NULL COMMENT '담당자명',
  contact_email VARCHAR(200) NULL COMMENT '담당자 이메일',
  sales_receipt VARCHAR(100) NULL COMMENT '판매전표 번호',
  event_name VARCHAR(200) NULL COMMENT '이벤트명',
  product_info VARCHAR(200) NULL COMMENT '품목/수량 정보',
  special_notes TEXT NULL COMMENT '특이사항',
  desired_completion_date DATETIME NULL COMMENT '완료 희망일시',
  reference_notes TEXT NULL COMMENT '참고사항',
  status ENUM('PENDING', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING' COMMENT '요청 상태',
  requested_by BIGINT NOT NULL COMMENT '요청자 FK) user.id',
  requested_at DATETIME NOT NULL COMMENT '요청 일시',
  executed_by BIGINT NULL COMMENT '파기 실행자 FK) user.id',
  executed_at DATETIME NULL COMMENT '파기 실행 일시',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  INDEX idx_early_destroy_request_order_id (order_id),
  INDEX idx_early_destroy_request_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='조기 개인정보파기 요청';

-- 조기 개인정보파기 요청 항목 테이블
CREATE TABLE early_destroy_request_item (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  early_destroy_request_id BIGINT NOT NULL COMMENT 'FK) early_destroy_request.id',
  order_product_mapping_id BIGINT NOT NULL COMMENT 'FK) order_product_mapping.id',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  deleted_at DATETIME(6) NULL,
  INDEX idx_early_destroy_request_item_request_id (early_destroy_request_id),
  INDEX idx_early_destroy_request_item_opm_id (order_product_mapping_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='조기 개인정보파기 요청 항목';
