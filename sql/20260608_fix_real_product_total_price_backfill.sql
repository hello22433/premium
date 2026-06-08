-- 실물상품 매핑 total_price 보정
-- total_price는 공급가액(price) * 수량(quantity)에 부가세를 더한 총액이어야 한다.

-- 배포 전 영향 범위 확인
SELECT
  COUNT(*) AS polluted_count
FROM `order_real_product_mapping`
WHERE `total_price` <> (`price` * `quantity`) + FLOOR((`price` * `quantity`) * 0.1);

-- 과거에 수량이 반영되지 않은 total_price가 저장된 row만 보정
UPDATE `order_real_product_mapping`
SET `total_price` = (`price` * `quantity`) + FLOOR((`price` * `quantity`) * 0.1)
WHERE `total_price` <> (`price` * `quantity`) + FLOOR((`price` * `quantity`) * 0.1);

-- 배포 후 검증
SELECT
  COUNT(*) AS remaining_polluted_count
FROM `order_real_product_mapping`
WHERE `total_price` <> (`price` * `quantity`) + FLOOR((`price` * `quantity`) * 0.1);
