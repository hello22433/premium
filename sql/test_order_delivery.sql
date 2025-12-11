-- 테스트 발송용 주문 배송 테이블
-- 알림톡 테스트 발송 시 쿠폰 정보 조회를 위해 임시로 저장되는 테이블

CREATE TABLE test_order_delivery (
    id INT AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(50) NOT NULL COMMENT '전송 상태',
    order_product_mapping_id INT NOT NULL COMMENT 'FK) order_product_mapping.id',
    delivery_method VARCHAR(50) NOT NULL COMMENT '전달 방식 ex) EMAIL, SMS, ALIM_TALK',
    delivery_target VARCHAR(128) NOT NULL COMMENT 'EMAIL 일 경우 email, SMS, ALIM_TALK 일 경우 핸드폰 번호',
    image_path VARCHAR(512) NULL COMMENT '이미지 경로',
    replace_character_1 VARCHAR(200) NULL COMMENT '대치문자 1',
    replace_character_2 VARCHAR(200) NULL COMMENT '대치문자 2',
    replace_character_3 VARCHAR(200) NULL COMMENT '대치문자 3',
    send_request_at DATETIME NOT NULL COMMENT '발송 요청 시각',
    expire_at DATETIME NULL COMMENT '만료 시간',
    bar_code VARCHAR(256) NULL COMMENT '전송 바코드 (테스트용 999999)',
    personal_code VARCHAR(50) NULL COMMENT '개인번호 (테스트용 999999)',
    coupon_status VARCHAR(50) DEFAULT 'NOT_USED' COMMENT '쿠폰 사용 상태',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '생성일',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일',
    INDEX idx_order_product_mapping_id (order_product_mapping_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='테스트 발송용 주문 배송 테이블';
