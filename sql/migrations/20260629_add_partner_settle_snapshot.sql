ALTER TABLE `order_product_mapping`
  ADD COLUMN `partner_settle_price_adjustment` ENUM('DISCOUNT', 'ADDITIONAL') NULL COMMENT '[snapshot] 협력사 정산 시 사용되는 할인 방법',
  ADD COLUMN `partner_settle_fee` INT NULL COMMENT '[snapshot] 협력사 정산 시 사용되는 수수료 (percent)';

-- 배포시점 동결(containment): 기존 행은 현재 매칭되는 BULK 할인 조건으로 backfill.
-- SECTION(가격구간) 방식은 range+compareCondition 로직을 SQL로 재현 불가하므로 제외 → fee=0 처리.
-- 우선순위: BRAND > CATEGORY > PRODUCT_GROUP (findMatchingDiscount 동일 순서).
-- 브랜드 매칭: ud.primary_category = product.brand.name_korean (brand join 필요).
-- 배포 이후 신규 주문은 애플리케이션에서 정확히 박제되므로 기존 행만 영향.
UPDATE `order_product_mapping` opm
  INNER JOIN `product` p ON p.id = opm.product_id
  -- BRAND BULK 우선 (primary_category = brand.name_korean)
  LEFT JOIN `user_discount` ud_brand
    ON ud_brand.partner_company_id = p.partner_company_id
    AND ud_brand.deleted_at IS NULL
    AND ud_brand.category = 'BRAND'
    AND ud_brand.method = 'BULK'
    AND EXISTS (
      SELECT 1 FROM `brand` b
      WHERE b.id = p.brand_id
        AND b.name_korean = ud_brand.primary_category
    )
  -- CATEGORY BULK (classification_id 일치)
  LEFT JOIN `user_discount` ud_category
    ON ud_category.partner_company_id = p.partner_company_id
    AND ud_category.deleted_at IS NULL
    AND ud_category.category = 'CATEGORY'
    AND ud_category.method = 'BULK'
    AND ud_category.classification_id = p.classification_id
  -- PRODUCT_GROUP BULK (group = product.category)
  LEFT JOIN `user_discount` ud_group
    ON ud_group.partner_company_id = p.partner_company_id
    AND ud_group.deleted_at IS NULL
    AND ud_group.category = 'PRODUCT_GROUP'
    AND ud_group.method = 'BULK'
    AND ud_group.`group` = p.category
SET
  -- 우선순위: BRAND > CATEGORY > PRODUCT_GROUP, 없으면 0/NULL
  opm.partner_settle_fee = COALESCE(
    ud_brand.price_percent,
    ud_category.price_percent,
    ud_group.price_percent,
    0
  ),
  opm.partner_settle_price_adjustment = COALESCE(
    ud_brand.price_adjustment,
    ud_category.price_adjustment,
    ud_group.price_adjustment,
    NULL
  )
WHERE opm.partner_settle_fee IS NULL
  AND p.partner_company_id IS NOT NULL;
