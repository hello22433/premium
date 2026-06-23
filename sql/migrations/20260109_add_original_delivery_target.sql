-- order_delivery 테이블에 original_delivery_target 컬럼 추가
-- CS에서 수신정보 변경 시에도 원본 발송 수신정보를 보존하기 위함

ALTER TABLE order_delivery
ADD COLUMN original_delivery_target VARCHAR(128) NULL
COMMENT '최초 발송 수신정보 (암호화, CS 변경 시에도 불변)'
AFTER delivery_target;

-- 기존 데이터 마이그레이션: delivery_target 값을 original_delivery_target에 복사
UPDATE order_delivery
SET original_delivery_target = delivery_target
WHERE original_delivery_target IS NULL;
