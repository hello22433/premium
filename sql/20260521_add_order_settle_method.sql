-- PR3 Wallet: order.settle_method 컬럼 추가
-- order.cardSurchargeApplied 와 동기화 (CARD↔true, CASH↔false)
-- 발송확정 시점에 order_payment_allocation.settle_method_snapshot 으로 복사

ALTER TABLE `order`
  ADD COLUMN `settle_method` VARCHAR(20) NULL
    COMMENT '정산 방법 (CARD/CASH). 발송확정 전까지 정산입력 UI 에서 변경 가능. cardSurchargeApplied 와 동기화'
  AFTER `card_surcharge_applied`;

-- 기존 주문에 값 부여 (user.settleMethod 우선, fallback 'CASH')
UPDATE `order` o
  JOIN `user` u ON o.user_id = u.id
   SET o.settle_method = IFNULL(u.settle_method, 'CASH')
 WHERE o.settle_method IS NULL;
