-- SSG 재발급/재발송 정합성 진단 및 제한적 백필 초안 (#59, #60)
-- 적용 원칙:
--   1) SELECT 진단 결과를 먼저 저장/검토한다.
--   2) 충돌 조회가 0건일 때만 백필 블록을 트랜잭션으로 실행한다.
--   3) #60은 ssg_resend_deduct_recovery 멱등 로그가 없는 후보만 임시 테이블에 담아 처리한다.
--   4) 운영 적용 전 row count와 샘플 order_delivery_id를 별도 리뷰한다.

-- ============================================================================
-- #59 진단: CONFIRMED + PIN payload는 있으나 order_delivery.ssg_event_id가
--           ssg_issue_log의 같은 PIN 귀속 행사와 다르거나 비어 있는 후보.
-- ============================================================================

SELECT
  od.id AS order_delivery_id,
  od.ssg_event_id AS current_ssg_event_id,
  sil.ssg_event_id AS issue_log_ssg_event_id,
  od.bar_code,
  od.personal_code,
  sil.id AS issue_log_id,
  s.updated_at AS confirmed_at
FROM order_delivery od
JOIN order_delivery_ssg_insert_state s
  ON s.order_delivery_id = od.id
 AND s.state = 'CONFIRMED'
JOIN ssg_issue_log sil
  ON sil.order_delivery_id = od.id
 AND sil.bar_code = od.bar_code
 AND sil.personal_code = od.personal_code
 AND sil.ssg_event_id IS NOT NULL
WHERE od.bar_code IS NOT NULL
  AND od.personal_code IS NOT NULL
  AND (od.ssg_event_id IS NULL OR od.ssg_event_id <> sil.ssg_event_id)
ORDER BY od.id, sil.id DESC;

-- #59 충돌 조회: 같은 배송/PIN 조합에 서로 다른 ssg_event_id가 있으면 자동 백필 금지.
SELECT
  sil.order_delivery_id,
  sil.bar_code,
  sil.personal_code,
  COUNT(DISTINCT sil.ssg_event_id) AS distinct_ssg_event_ids,
  GROUP_CONCAT(DISTINCT sil.ssg_event_id ORDER BY sil.ssg_event_id) AS ssg_event_ids
FROM ssg_issue_log sil
JOIN order_delivery od
  ON od.id = sil.order_delivery_id
 AND od.bar_code = sil.bar_code
 AND od.personal_code = sil.personal_code
JOIN order_delivery_ssg_insert_state s
  ON s.order_delivery_id = od.id
 AND s.state = 'CONFIRMED'
WHERE sil.ssg_event_id IS NOT NULL
GROUP BY sil.order_delivery_id, sil.bar_code, sil.personal_code
HAVING COUNT(DISTINCT sil.ssg_event_id) > 1;

-- #59 백필: 위 충돌 조회가 0건일 때만 실행.
-- START TRANSACTION;
-- UPDATE order_delivery od
-- JOIN order_delivery_ssg_insert_state s
--   ON s.order_delivery_id = od.id
--  AND s.state = 'CONFIRMED'
-- JOIN ssg_issue_log sil
--   ON sil.order_delivery_id = od.id
--  AND sil.bar_code = od.bar_code
--  AND sil.personal_code = od.personal_code
--  AND sil.ssg_event_id IS NOT NULL
-- SET od.ssg_event_id = sil.ssg_event_id
-- WHERE od.bar_code IS NOT NULL
--   AND od.personal_code IS NOT NULL
--   AND (od.ssg_event_id IS NULL OR od.ssg_event_id <> sil.ssg_event_id)
--   AND NOT EXISTS (
--     SELECT 1
--     FROM ssg_issue_log x
--     WHERE x.order_delivery_id = od.id
--       AND x.bar_code = od.bar_code
--       AND x.personal_code = od.personal_code
--       AND x.ssg_event_id IS NOT NULL
--       AND x.ssg_event_id <> sil.ssg_event_id
--   );
-- COMMIT;

-- ============================================================================
-- #60 진단: CS_REISSUE pending은 KEPT인데 최종 PIN과 매칭되는 issue_log가
--           pending 생성 이전에 존재하는 후보. 기존/후보 PIN 재사용으로 볼 수 있는 제한 후보.
--           단순 event_id 불일치만 보면, 재사용 PIN과 선차감 행사가 우연히 같은 경우를 놓칠 수 있다.
-- ============================================================================

SELECT
  p.id AS pending_id,
  p.resend_deduction_id,
  p.order_id,
  p.issue_order_delivery_id,
  p.ssg_event_id AS deducted_ssg_event_id,
  od.ssg_event_id AS actual_delivery_ssg_event_id,
  sil.ssg_event_id AS reused_issue_log_ssg_event_id,
  sil.id AS reused_issue_log_id,
  sil.inserted_at AS reused_issue_inserted_at,
  p.created_at AS pending_created_at,
  p.amount,
  p.resolution,
  p.issue_outcome,
  p.resolved_at
FROM ssg_resend_deduct_pending p
JOIN order_delivery od
  ON od.id = p.issue_order_delivery_id
JOIN ssg_issue_log sil
  ON sil.order_delivery_id = od.id
 AND sil.bar_code = od.bar_code
 AND sil.personal_code = od.personal_code
 AND sil.ssg_event_id IS NOT NULL
 AND sil.inserted_at < p.created_at
LEFT JOIN ssg_resend_deduct_recovery r
  ON r.resend_deduction_id = p.resend_deduction_id
WHERE p.purpose = 'CS_REISSUE'
  AND p.resolution = 'KEPT'
  AND p.resolved_at IS NOT NULL
  AND p.issue_order_delivery_id IS NOT NULL
  AND od.bar_code IS NOT NULL
  AND od.personal_code IS NOT NULL
  AND r.id IS NULL
ORDER BY p.id;

-- #60 충돌 조회: 이미 역복원 로그가 있거나, 실제 재사용 근거를 단일하게 확인할 수 없는 후보는 자동 백필 금지.
SELECT
  p.id AS pending_id,
  p.resend_deduction_id,
  p.issue_order_delivery_id,
  p.ssg_event_id AS deducted_ssg_event_id,
  od.ssg_event_id AS actual_delivery_ssg_event_id,
  r.id AS recovery_id,
  COUNT(DISTINCT sil.ssg_event_id) AS prior_issue_log_event_count,
  GROUP_CONCAT(DISTINCT sil.ssg_event_id ORDER BY sil.ssg_event_id) AS prior_issue_log_event_ids,
  CASE
    WHEN r.id IS NOT NULL THEN 'ALREADY_RECOVERED'
    WHEN od.bar_code IS NULL OR od.personal_code IS NULL THEN 'FINAL_PIN_UNKNOWN'
    WHEN COUNT(sil.id) = 0 THEN 'NO_PRIOR_PIN_LOG'
    WHEN COUNT(DISTINCT sil.ssg_event_id) > 1 THEN 'MULTIPLE_PRIOR_PIN_EVENTS'
    ELSE 'REVIEW'
  END AS review_reason
FROM ssg_resend_deduct_pending p
LEFT JOIN order_delivery od
  ON od.id = p.issue_order_delivery_id
LEFT JOIN ssg_resend_deduct_recovery r
  ON r.resend_deduction_id = p.resend_deduction_id
LEFT JOIN ssg_issue_log sil
  ON sil.order_delivery_id = od.id
 AND sil.bar_code = od.bar_code
 AND sil.personal_code = od.personal_code
 AND sil.ssg_event_id IS NOT NULL
 AND sil.inserted_at < p.created_at
WHERE p.purpose = 'CS_REISSUE'
  AND p.resolution = 'KEPT'
  AND p.resolved_at IS NOT NULL
GROUP BY
  p.id,
  p.resend_deduction_id,
  p.issue_order_delivery_id,
  p.ssg_event_id,
  od.ssg_event_id,
  r.id
HAVING review_reason <> 'REVIEW';

-- #60 백필: 진단 후보가 실제 재사용으로 확정되고 충돌 조회에서 제외된 경우만 실행.
-- 같은 세션/트랜잭션에서 임시 테이블에 후보를 고정해 재실행 이중가산을 방지한다.
-- START TRANSACTION;
-- CREATE TEMPORARY TABLE tmp_ssg_reissue_reuse_backfill_20260723 AS
-- SELECT
--   p.resend_deduction_id,
--   p.ssg_event_id,
--   p.order_id,
--   p.amount,
--   MIN(sil.id) AS evidence_issue_log_id
-- FROM ssg_resend_deduct_pending p
-- JOIN order_delivery od
--   ON od.id = p.issue_order_delivery_id
-- JOIN ssg_issue_log sil
--   ON sil.order_delivery_id = od.id
--  AND sil.bar_code = od.bar_code
--  AND sil.personal_code = od.personal_code
--  AND sil.ssg_event_id IS NOT NULL
--  AND sil.inserted_at < p.created_at
-- LEFT JOIN ssg_resend_deduct_recovery r
--   ON r.resend_deduction_id = p.resend_deduction_id
-- WHERE p.purpose = 'CS_REISSUE'
--   AND p.resolution = 'KEPT'
--   AND p.resolved_at IS NOT NULL
--   AND p.issue_order_delivery_id IS NOT NULL
--   AND od.bar_code IS NOT NULL
--   AND od.personal_code IS NOT NULL
--   AND r.id IS NULL
-- GROUP BY
--   p.resend_deduction_id,
--   p.ssg_event_id,
--   p.order_id,
--   p.amount
-- HAVING COUNT(DISTINCT sil.ssg_event_id) = 1;
--
-- INSERT INTO ssg_resend_deduct_recovery (resend_deduction_id, ssg_event_id, order_id, amount)
-- SELECT resend_deduction_id, ssg_event_id, order_id, amount
-- FROM tmp_ssg_reissue_reuse_backfill_20260723;
--
-- UPDATE ssg_event e
-- JOIN tmp_ssg_reissue_reuse_backfill_20260723 t
--   ON t.ssg_event_id = e.id
-- SET e.event_balance = e.event_balance + t.amount;
--
-- UPDATE ssg_resend_deduct_pending p
-- JOIN tmp_ssg_reissue_reuse_backfill_20260723 t
--   ON t.resend_deduction_id = p.resend_deduction_id
-- SET p.resolution = 'REVERSED',
--     p.issue_outcome = 'REUSED'
-- WHERE p.resolution = 'KEPT';
--
-- SELECT COUNT(*) AS backfilled_rows
-- FROM tmp_ssg_reissue_reuse_backfill_20260723;
-- COMMIT;
