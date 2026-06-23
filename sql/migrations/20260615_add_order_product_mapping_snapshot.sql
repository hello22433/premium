ALTER TABLE order_product_mapping
  ADD COLUMN snapshot_product_price INT NULL COMMENT '[snapshot] 주문 시점 상품 단가',
  ADD COLUMN snapshot_product_name VARCHAR(255) NULL COMMENT '[snapshot] 주문 시점 상품명',
  ADD COLUMN snapshot_product_brand_name VARCHAR(255) NULL COMMENT '[snapshot] 주문 시점 브랜드명',
  ADD COLUMN snapshot_product_expire_day INT NULL COMMENT '[snapshot] 주문 시점 유효기간 일수',
  ADD COLUMN snapshot_product_image_path VARCHAR(500) NULL COMMENT '[snapshot] 주문 시점 상품 이미지 경로';
