-- 정산확정 시점의 순 정산금액을 스냅샷으로 보관
-- 배경: 선정산 계정의 정산 토글(SETTLE_COMPLETE ↔ UNSETTLE_NORMAL) 시 현재 delivery 상태로 재계산하면
--        확정 후 폐기 발생 케이스에서 금액이 원상 복구되지 않음 (drift 발생)
-- 해결: 정산확정 시점의 netAmount를 order.settled_amount_snapshot에 기록하고 해제 시 이 값으로 역방향 적용

ALTER TABLE `order`
  ADD COLUMN settled_amount_snapshot INT NULL
    COMMENT '정산확정 시점의 유효 정산금액 스냅샷 (해제 시 역방향 복원에 사용)'
    AFTER settle_amount;

-- 백필: 이미 SETTLE_COMPLETE 상태인 주문에 대해 현재 유효 delivery들의 정산단가 합계로 초기화
-- 주의: 확정 시점과 현재 delivery 상태가 다를 수 있어 정확한 snapshot은 아님. 최선의 근사값.
-- 해제가 일어나기 전까지는 미활용 값이므로 drift 가능성은 제한적.
UPDATE `order` o
JOIN (
  SELECT
    opm.order_id,
    SUM(
      CASE
        WHEN COALESCE(od.settle_fee, opm.fee, 0) = 0 THEN p.price
        WHEN COALESCE(od.settle_price_adjustment, opm.price_adjustment) = 'DISCOUNT'
          THEN p.price - FLOOR(p.price * COALESCE(od.settle_fee, opm.fee) / 100)
        WHEN COALESCE(od.settle_price_adjustment, opm.price_adjustment) = 'ADDITIONAL'
          THEN p.price + FLOOR(p.price * COALESCE(od.settle_fee, opm.fee) / 100)
        ELSE p.price
      END
      + CASE WHEN o2.card_surcharge_applied = 1
          THEN FLOOR(
            (CASE
              WHEN COALESCE(od.settle_fee, opm.fee, 0) = 0 THEN p.price
              WHEN COALESCE(od.settle_price_adjustment, opm.price_adjustment) = 'DISCOUNT'
                THEN p.price - FLOOR(p.price * COALESCE(od.settle_fee, opm.fee) / 100)
              WHEN COALESCE(od.settle_price_adjustment, opm.price_adjustment) = 'ADDITIONAL'
                THEN p.price + FLOOR(p.price * COALESCE(od.settle_fee, opm.fee) / 100)
              ELSE p.price
            END) * 3 / 100
          )
          ELSE 0
        END
    ) AS net_amount
  FROM order_product_mapping opm
  JOIN `order` o2 ON o2.id = opm.order_id
  JOIN order_delivery od ON od.order_product_mapping_id = opm.id
  JOIN product p ON p.id = opm.product_id
  WHERE o2.settle_status = 'SETTLE_COMPLETE'
    AND od.deleted_at IS NULL
    AND od.status IN ('COMPLETE', 'COMPLETE_SMS')
    AND od.coupon_status != 'CANCEL'
  GROUP BY opm.order_id
) summary ON summary.order_id = o.id
SET o.settled_amount_snapshot = summary.net_amount
WHERE o.settle_status = 'SETTLE_COMPLETE' AND o.settled_amount_snapshot IS NULL;