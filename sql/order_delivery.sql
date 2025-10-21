ALTER TABLE order_delivery
    ADD COLUMN refund_status ENUM('PROGRESS', 'APPROVE', 'COMPLETE') NULL COMMENT '환불 상태';

ALTER TABLE order_delivery
    ADD COLUMN refund_ratio INT NULL COMMENT '환불 률 1~100 으로 저장 및 사용';

ALTER TABLE order_delivery
    ADD COLUMN refund_register_at DATETIME NULL COMMENT '환불 접수 일자';

ALTER TABLE order_delivery
    ADD COLUMN bank_name VARCHAR(255) NULL COMMENT '은행명';

ALTER TABLE order_delivery
    ADD COLUMN bank_account VARCHAR(255) NULL COMMENT '계좌번호';

ALTER TABLE order_delivery
    ADD COLUMN bank_account_owner VARCHAR(255) NULL COMMENT '예금주';

ALTER TABLE order_delivery
    ADD COLUMN refund_at DATETIME NULL COMMENT '환불일자';