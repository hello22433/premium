ALTER TABLE epopkon.`order` ADD encourage_day int NULL COMMENT '독려 문자 day';

ALTER TABLE epopkon.`order` ADD test_delivery_count int NULL COMMENT '테스트 알림 횟수' AFTER encourage_day;

ALTER TABLE epopkon.order_delivery ADD encourage_at datetime NULL COMMENT '독려 문자 일시';

ALTER TABLE `order`
    ADD COLUMN settle_status ENUM('UNSETTLE_OVERDUE', 'UNSETTLE_NORMAL', 'SETTLE_COMPLETE') NULL COMMENT '정산상태';

ALTER TABLE `order`
    ADD COLUMN is_settle_complete TINYINT(1) DEFAULT 0 COMMENT '정산 확정 여부';