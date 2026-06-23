-- 조기 개인정보파기 — 발송건 단위 파기 지원 + 단건/복수/주문 단위 API 확장
-- 1) early_destroy_request_item 에 order_delivery_id 추가 (NULL이면 매핑 전체 파기)
ALTER TABLE early_destroy_request_item
  ADD COLUMN order_delivery_id BIGINT NULL COMMENT 'FK) order_delivery.id (NULL이면 매핑 전체 파기)'
  AFTER order_product_mapping_id;

CREATE INDEX idx_early_destroy_request_item_order_delivery_id
  ON early_destroy_request_item(order_delivery_id);
