ALTER TABLE epopkon.order_from_definition
ADD request_status ENUM('PENDING', 'APPROVED', 'REJECTED') DEFAULT 'PENDING' NULL COMMENT 'PENDING - 요청중, APPROVED - 승인, REJECTED - 거절';

ALTER TABLE order_from_definition
    ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE
  COMMENT '기본 발신번호 여부';
