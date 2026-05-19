-- DEFERRED ledger row 추적
-- plans/ssg-balance-refactor.md PR5
--
-- SsgRefundResolverService.resolveAndRefundIfNeeded() 가 DEFERRED 반환 시
-- ledger.ssg_balance_settled 가 false 로 남는다.
-- 정상 흐름이라면 resolver 가 RESTORED/SKIPPED_CONFIRMED 반환하고 markSsgSettled(true) 가 호출되어야 한다.
--
-- row > 0 → 운영팀 즉시 알림. SSG 행사 잔액 보정이 끝나지 않은 ledger 가 누적되면
-- 후속 재발송 가드가 차단되어 사용자가 재발송 못 함.
--
-- 조치: 해당 orderDeliveryId 에 대해 SsgRefundResolverService 재호출 또는 운영 SQL 로 수동 보정.

SELECT
  r.id AS refund_id,
  r.order_delivery_id,
  r.user_id,
  r.refund_amount,
  r.source_path,
  r.refunded_at,
  r.memo,
  od.status AS delivery_status,
  od.bar_code,
  od.ssg_event_id,
  st.state AS insert_state,
  TIMESTAMPDIFF(MINUTE, r.refunded_at, NOW()) AS minutes_since_refund
FROM order_delivery_refund r
LEFT JOIN order_delivery od ON od.id = r.order_delivery_id
LEFT JOIN order_delivery_ssg_insert_state st ON st.order_delivery_id = r.order_delivery_id
WHERE r.ssg_balance_settled = FALSE
ORDER BY r.refunded_at ASC;
