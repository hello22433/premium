-- 주문 테이블에 카드할증 적용 여부 컬럼 추가
ALTER TABLE `order`
  ADD COLUMN `card_surcharge_applied` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '카드할증 적용 여부 (3%)' AFTER `is_new_billing_flow`;
