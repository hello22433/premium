ALTER TABLE `order_product_mapping`
  ADD COLUMN `partner_settle_price_adjustment` ENUM('DISCOUNT', 'ADDITIONAL') NULL COMMENT '[snapshot] 협력사 정산 시 사용되는 할인 방법',
  ADD COLUMN `partner_settle_fee` INT NULL COMMENT '[snapshot] 협력사 정산 시 사용되는 수수료 (percent)';
