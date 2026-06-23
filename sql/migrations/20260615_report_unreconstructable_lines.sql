-- =============================================================================
-- Backfill audit: rows that could NOT be exactly reconstructed
-- =============================================================================
-- Run AFTER step (b), BEFORE step (c) in the backfill file
-- (20260615_backfill_order_product_mapping_snapshot.sql).
--
-- This query lists every order_product_mapping row whose snapshot_product_price
-- is still NULL after the single-line exact-reconstruction pass.
-- These are the rows that step (c) will fill with the LIVE product.price.
-- Review the output before running step (c) to understand the scope of
-- best-effort (non-exact) price backfill.
-- =============================================================================

SELECT
  opm.order_id,
  opm.id                                                              AS mapping_id,
  opm.product_id,
  opm.amount,
  o.send_amount,
  (
    SELECT COUNT(*)
    FROM order_product_mapping m2
    WHERE m2.order_id = opm.order_id
  )                                                                   AS line_count,
  CASE
    WHEN o.send_amount IS NULL
      THEN 'null_send_amount'
    WHEN opm.amount = 0
      THEN 'zero_amount'
    WHEN (
      SELECT COUNT(*)
      FROM order_product_mapping m3
      WHERE m3.order_id = opm.order_id
    ) > 1
      THEN 'multi_line'
    WHEN o.send_amount MOD NULLIF(opm.amount, 0) <> 0
      THEN 'not_divisible'
    ELSE 'other'
  END                                                                 AS reason
FROM order_product_mapping opm
JOIN `order` o ON o.id = opm.order_id
WHERE opm.snapshot_product_price IS NULL
ORDER BY reason, opm.order_id, opm.id;
