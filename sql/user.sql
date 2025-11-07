ALTER TABLE user
    ADD COLUMN settle_period_condition ENUM('CURRENT_MONTH', 'NEXT_MONTH', 'NEXT_MONTH_AFTER', 'DELIVERY_DATE') NULL COMMENT '정산 기준 지정 월 조건';

ALTER TABLE user
    ADD COLUMN settle_period_count INT NULL COMMENT '정산 기준 일 수';

ALTER TABLE order ADD COLUMN settle_status ENUM('UNSETTLE_OVERDUE', 'UNSETTLE_NORMAL', 'SETTLE_COMPLETE') NULL COMMENT '정산상태';

ALTER TABLE user
    ADD COLUMN all_settle_amount INT DEFAULT 0 COMMENT '전체 주문 완료 금액';

ALTER TABLE user
    ADD COLUMN service_amount INT DEFAULT 0 COMMENT '서비스 금액';

UPDATE
    user u
SET
    u.all_settle_amount = (
        SELECT
            COALESCE(SUM(o.settle_amount), 0)
        FROM
            `order` o
        WHERE
            o.user_id = u.id
          AND (o.status = 'DELIVERY_COMPLETE'
            or o.status = 'DELIVERY_REQUEST'
            or o.status = 'DELIVERY_CONFIRMED')
          and (o.settle_status != 'SETTLE_COMPLETE' or o.settle_status is null)
    );