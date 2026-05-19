-- SSG INSERT state 분포 + ATTEMPTED 잔여 알림
-- plans/ssg-balance-refactor.md PR5
--
-- order_delivery_ssg_insert_state 의 state 분포 점검.
-- ATTEMPTED 가 일정 시간(예: 30분) 이상 잔존하면 orphan resolver 호출 누락 또는
-- SSG check API 응답 지연 가능. 운영 알림 대상.

-- 1) 전체 state 분포 (NONE 은 row 없음으로 표현되므로 별도 계산)
SELECT
  COALESCE(state, 'NONE_NO_ROW') AS state,
  COUNT(*) AS row_count
FROM (
  SELECT st.state
  FROM order_delivery od
  JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
  JOIN `order` o ON o.id = opm.order_id
  LEFT JOIN order_delivery_ssg_insert_state st ON st.order_delivery_id = od.id
  WHERE o.type = 'SSG'
) t
GROUP BY state
ORDER BY state;

-- 2) ATTEMPTED 잔여 — 일정 시간 이상 (예: 30분) 잔존한 row
SELECT
  st.order_delivery_id,
  st.state,
  st.created_at,
  st.updated_at,
  TIMESTAMPDIFF(MINUTE, st.updated_at, NOW()) AS minutes_since_update,
  od.status AS delivery_status,
  od.bar_code,
  od.failed_at
FROM order_delivery_ssg_insert_state st
JOIN order_delivery od ON od.id = st.order_delivery_id
WHERE st.state = 'ATTEMPTED'
  AND st.updated_at < NOW() - INTERVAL 30 MINUTE
ORDER BY st.updated_at ASC;

-- 3) legacy backfill 검증 — CONFIRMED 인데 barCode IS NULL (비정상)
SELECT
  od.id AS order_delivery_id,
  od.status,
  od.bar_code,
  od.ssg_event_id,
  st.state,
  st.updated_at
FROM order_delivery_ssg_insert_state st
JOIN order_delivery od ON od.id = st.order_delivery_id
WHERE st.state = 'CONFIRMED'
  AND od.bar_code IS NULL;
