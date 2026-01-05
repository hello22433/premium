ALTER TABLE email_send_history
    ADD COLUMN order_delivery_id INT NULL COMMENT '주문 발송 ID (이메일 쿠폰용)',
    ADD INDEX idx_order_delivery_id (order_delivery_id);