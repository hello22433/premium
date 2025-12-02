ALTER TABLE order_product_mapping
    ADD COLUMN send_method ENUM('ALIM_TALK', 'SMS', 'EMAIL') NULL COMMENT '발신 수단 ex) ALIM_TALK: 알림톡, SMS: SMS, EMAIL: 이메일',
ADD COLUMN send_tail_text VARCHAR(100) NULL COMMENT '꼬리 광고 text',
ADD COLUMN request_to_destroy_personal_info_day INT NULL COMMENT '개인정보 파기 요청일',
ADD COLUMN from_phone_number VARCHAR(20) NULL COMMENT '발신 번호',
ADD COLUMN send_title VARCHAR(20) NULL COMMENT '발신 제목',
ADD COLUMN send_content VARCHAR(200) NULL COMMENT '발신 내용',
ADD COLUMN from_email VARCHAR(100) NULL COMMENT '발신 이메일',
ADD COLUMN email_send_type ENUM('QR', 'URL') NULL COMMENT 'QR: QR, URL: URL',
ADD COLUMN use_email_content TEXT NULL COMMENT '이메일 사용 방법',
ADD COLUMN send_request_at DATETIME NULL COMMENT '발송 요청 시각',
ADD COLUMN send_type VARCHAR(50) NULL COMMENT '발송 방식',
ADD COLUMN encourage_day INT NULL COMMENT '독려 문자 day (만료일 N일 전 발송)';