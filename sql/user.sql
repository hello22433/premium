ALTER TABLE user
    ADD COLUMN settle_period_condition ENUM('CURRENT_MONTH', 'NEXT_MONTH', 'NEXT_MONTH_AFTER', 'DELIVERY_DATE') NULL COMMENT '정산 기준 지정 월 조건';

ALTER TABLE user
    ADD COLUMN settle_period_count INT NULL COMMENT '정산 기준 일 수';

ALTER TABLE order ADD COLUMN settle_status ENUM('UNSETTLE_OVERDUE', 'UNSETTLE_NORMAL', 'SETTLE_COMPLETE') NULL COMMENT '정산상태';

ALTER TABLE user
    ADD COLUMN all_settle_amount INT DEFAULT 0 COMMENT '전체 주문 완료 금액';

ALTER TABLE user
    ADD COLUMN service_amount INT DEFAULT 0 COMMENT '서비스 금액';

ALTER TABLE user
    ADD COLUMN duplicate_phone_limit INT DEFAULT 0 NOT NULL COMMENT '중복번호제어 (0: 중복허용, 1~10: 해당 개수만큼 중복 허용)';

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


ALTER TABLE user ADD authority_list varchar(1024) NULL COMMENT '페이지 접근 허용 list';

ALTER TABLE `epopkon`.`user`
    ADD COLUMN `password_changed_at` DATETIME NULL DEFAULT NULL
  COMMENT '비밀번호 마지막 변경 일시';

ALTER TABLE `user`
    ADD COLUMN `industry_type` VARCHAR(100) NULL COMMENT '업태' AFTER `authority_list`,
    ADD COLUMN `industry_item` VARCHAR(100) NULL COMMENT '종목' AFTER `industry_type`;

ALTER TABLE `user`
  ADD COLUMN `allowed_send_methods` VARCHAR(100) NOT NULL DEFAULT 'ALIM_TALK,SMS,EMAIL'
  COMMENT '허용 발신수단 목록 (쉼표 구분: ALIM_TALK,SMS,EMAIL)';