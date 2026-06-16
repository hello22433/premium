-- =============================================================================
-- Legacy backfill: order_product_mapping snapshot columns
-- =============================================================================
-- Run order: dev first → verify counts → prod
-- All statements are IDEMPOTENT (only update rows where the target column IS NULL).
--
-- Step (a)  : Backfill display fields (name, brand, expire_day, image_path)
--             from LIVE product/brand rows.
-- Step (b)  : Backfill price via exact single-line reconstruction:
--               unit_price = order.send_amount / order_product_mapping.amount
--             Only applies when:
--               - order has exactly ONE order_product_mapping row
--               - amount > 0
--               - send_amount IS NOT NULL
--               - send_amount MOD amount = 0  (divides evenly)
-- [REPORT]  : Before running step (c), run
--             20260615_report_unreconstructable_lines.sql
--             to capture which rows could NOT be exactly reconstructed.
-- Step (c)  : Backfill remaining NULL prices from LIVE product.price.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- (a) Display fields from LIVE product / brand (best-effort)
-- ---------------------------------------------------------------------------
UPDATE order_product_mapping opm
JOIN product p ON p.id = opm.product_id
LEFT JOIN brand b ON b.id = p.brand_id
SET
  opm.snapshot_product_name       = COALESCE(opm.snapshot_product_name,       p.name),
  opm.snapshot_product_brand_name = COALESCE(opm.snapshot_product_brand_name, b.name_korean),
  opm.snapshot_product_expire_day = COALESCE(opm.snapshot_product_expire_day, p.expire_day),
  opm.snapshot_product_image_path = COALESCE(opm.snapshot_product_image_path, p.image_path)
WHERE
     opm.snapshot_product_name       IS NULL
  OR opm.snapshot_product_brand_name IS NULL
  OR opm.snapshot_product_expire_day IS NULL
  OR opm.snapshot_product_image_path IS NULL;


-- ---------------------------------------------------------------------------
-- (b) Price — exact single-line reconstruction from order.send_amount
--
-- MySQL/MariaDB cannot reference the table being updated in a plain subquery
-- of the same UPDATE statement ("Can't reopen table" error).
-- The inner subquery that finds single-OPM order_ids is therefore wrapped in
-- an extra derived-table layer (SELECT * FROM (...) AS x) so that the engine
-- materialises the result set into a temporary table before the outer UPDATE
-- touches order_product_mapping, avoiding the reopen error.
-- ---------------------------------------------------------------------------
UPDATE order_product_mapping opm
JOIN (
  SELECT m.id AS mapping_id,
         o.send_amount,
         m.amount
  FROM order_product_mapping m
  JOIN `order` o ON o.id = m.order_id
  WHERE m.order_id IN (
    -- Extra wrapping layer forces materialisation before the outer UPDATE
    -- reads order_product_mapping, preventing the "can't reopen table" error.
    SELECT order_id FROM (
      SELECT order_id
      FROM order_product_mapping
      GROUP BY order_id
      HAVING COUNT(*) = 1
    ) AS single_line_orders
  )
) AS single ON single.mapping_id = opm.id
SET opm.snapshot_product_price = single.send_amount DIV single.amount
WHERE
      opm.snapshot_product_price IS NULL
  AND single.amount > 0
  AND single.send_amount IS NOT NULL
  AND single.send_amount MOD single.amount = 0;


-- ---------------------------------------------------------------------------
-- [REPORT CHECKPOINT]
-- Before running step (c) below, execute:
--   20260615_report_unreconstructable_lines.sql
-- This identifies every row whose price could NOT be exactly reconstructed
-- (multi-line order, zero amount, non-divisible, NULL send_amount) and shows
-- which LIVE fallback value will be written in step (c).
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- (c) Price — LIVE product.price fallback for all remaining NULLs
--     (multi-line orders, amount=0, non-divisible send_amount, NULL send_amount)
-- ---------------------------------------------------------------------------
UPDATE order_product_mapping opm
JOIN product p ON p.id = opm.product_id
SET opm.snapshot_product_price = p.price
WHERE opm.snapshot_product_price IS NULL;
