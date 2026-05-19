-- SSG event_balance 재계산 정합 점검
-- plans/ssg-balance-refactor.md PR5
--
-- 실제 엔티티: ssg_event_amount_history (ssg.event.amount.history.entity.ts)
-- 컬럼: id, ssg_event_id, amount (signed: 사용/충전 금액), balance, order_id, is_temporary
--
-- 산식: e.event_balance = e.event_price + SUM(h.amount) (확정 분만)
-- amount 는 signed 이므로 deduct 는 음수, refund 는 양수로 저장된다 (운영 의미).
--
-- 부등호 발생 시 SSG resolver / refundForFail / chargeBackForResend / deductEventBalance 호출 누락 의심.

SELECT
  e.id AS ssg_event_id,
  e.no AS event_no,
  e.`order` AS event_seq,
  e.name AS event_name,
  e.event_price,
  e.event_balance AS stored_balance,
  COALESCE(SUM(h.amount), 0) AS history_sum,
  (e.event_price + COALESCE(SUM(h.amount), 0)) AS recalculated_balance,
  e.event_balance - (e.event_price + COALESCE(SUM(h.amount), 0)) AS diff
FROM ssg_event e
LEFT JOIN ssg_event_amount_history h
  ON h.ssg_event_id = e.id
 AND h.is_temporary = FALSE
GROUP BY e.id
HAVING (e.event_balance - (e.event_price + COALESCE(SUM(h.amount), 0))) <> 0
ORDER BY ABS(e.event_balance - (e.event_price + COALESCE(SUM(h.amount), 0))) DESC;

-- 가차감(is_temporary=TRUE) 포함 점검 (참고용):
-- SELECT e.id, e.event_balance,
--        e.event_price + COALESCE(SUM(h.amount), 0) AS recalculated_with_temporary
-- FROM ssg_event e
-- LEFT JOIN ssg_event_amount_history h ON h.ssg_event_id = e.id
-- GROUP BY e.id
-- HAVING e.event_balance <> recalculated_with_temporary;
