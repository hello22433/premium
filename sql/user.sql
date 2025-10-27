ALTER TABLE user
    ADD COLUMN settle_period_condition ENUM('CURRENT_MONTH', 'NEXT_MONTH', 'NEXT_MONTH_AFTER', 'DELIVERY_DATE') NULL COMMENT '정산 기준 지정 월 조건';

ALTER TABLE user
    ADD COLUMN settle_period_count INT NULL COMMENT '정산 기준 일 수';