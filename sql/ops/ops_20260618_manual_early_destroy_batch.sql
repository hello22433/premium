-- =============================================================================
-- 수동 조기 개인정보파기 — 다건 일괄 (1519, 2074, 2221, 2576)
-- 일자: 2026-06-18
-- 사유: 고객사 요청 (조기파기 기능 미배포 상태에서 수동 처리), 동일 고객사
--
-- 동작 (EarlyDestroyService.executeRequest + createRequestForOrder 와 동일):
--   1. early_destroy_request          (주문당 1행, status=COMPLETED)
--   2. early_destroy_request_item     (매핑당 1행, order_delivery_id=NULL → 주문 단위)
--   3. order_delivery PII 5필드 마스킹 = '-'
--   4. order_history before_change/after_change = '-'
--        ⚠️ type IN ('수신정보 변경요청','폐기 후 신규 발송') 인 행만 (C-1).
--
-- 안전장치:
--   - 모든 변경은 START TRANSACTION 안
--   - order.status = 'DELIVERY_COMPLETE' 아닌 주문은 자동 스킵 (D5 에서 보고)
--   - 이미 '-' 마스킹된 발송건은 대상 제외 (멱등)
--   - 환불 PROGRESS/APPROVE 발송건은 B2 에서 사전 보고 → 발견 시 ROLLBACK
--
-- 사용법: 섹션 순서대로 실행. C 후 D 검증 → 정상이면 COMMIT, 아니면 ROLLBACK.
-- =============================================================================


-- =============================================================================
-- SECTION A. 파라미터 / 대상 주문 정의
-- =============================================================================
SET @actor_user_id  = 7;                              -- 실행 관리자 user.id
SET @client_company = '펑타이그레이터차이나 유한회사';                      -- ⚠️ 실제 고객사명으로 교체 (동일 고객사)
SET @run_at         = NOW();
SET @special_notes  = '고객사 요청 수동 일괄 조기파기 (2026-06-18)';

SELECT '[A0] params' AS info, @actor_user_id AS actor, @client_company AS client_company, @run_at AS run_at;

DROP TEMPORARY TABLE IF EXISTS _t_target_orders;
CREATE TEMPORARY TABLE _t_target_orders (
  order_id BIGINT NOT NULL PRIMARY KEY
) ENGINE=InnoDB;

INSERT INTO _t_target_orders (order_id) VALUES
  (1519),
  (2074),
  (2221),
  (2576);


-- =============================================================================
-- SECTION B. 사전 검증
-- =============================================================================

-- B1. 주문 상태 (DELIVERY_COMPLETE 아닌 건은 C 에서 자동 스킵)
SELECT t.order_id, o.status, o.user_id AS order_owner_user_id, o.created_at
FROM _t_target_orders t
LEFT JOIN `order` o ON o.id = t.order_id
ORDER BY t.order_id;

-- B2. 환불 진행/승인 발송건 — 1건이라도 나오면 절대 COMMIT 금지
SELECT od.id AS delivery_id, opm.order_id, od.refund_status, od.refund_register_at, od.approve_at
FROM order_delivery od
INNER JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
INNER JOIN _t_target_orders     t   ON t.order_id = opm.order_id
WHERE od.refund_status IN ('PROGRESS', 'APPROVE');

-- B3. 파기 대상 발송건 카운트 (이미 '-' 처리된 건 제외)
SELECT t.order_id,
       COALESCE(SUM(CASE WHEN od.delivery_target <> '-' OR od.original_delivery_target <> '-'
                         THEN 1 ELSE 0 END), 0) AS to_destroy_cnt,
       COALESCE(SUM(CASE WHEN od.delivery_target = '-' AND od.original_delivery_target = '-'
                         THEN 1 ELSE 0 END), 0) AS already_destroyed_cnt
FROM _t_target_orders t
LEFT JOIN `order`               o   ON o.id = t.order_id AND o.status = 'DELIVERY_COMPLETE'
LEFT JOIN order_product_mapping opm ON opm.order_id = o.id
LEFT JOIN order_delivery        od  ON od.order_product_mapping_id = opm.id
GROUP BY t.order_id
ORDER BY t.order_id;

-- B4. 매핑(상품) 카운트
SELECT t.order_id, COUNT(opm.id) AS mapping_count
FROM _t_target_orders t
LEFT JOIN order_product_mapping opm ON opm.order_id = t.order_id
GROUP BY t.order_id
ORDER BY t.order_id;


-- =============================================================================
-- SECTION C. 트랜잭션 — 실제 INSERT / UPDATE
-- =============================================================================
START TRANSACTION;

-- C1. 파기 대상 발송건 캐시 (status=DELIVERY_COMPLETE 인 주문만, 미마스킹 행만)
DROP TEMPORARY TABLE IF EXISTS _t_target_deliveries;
CREATE TEMPORARY TABLE _t_target_deliveries (
  delivery_id BIGINT NOT NULL PRIMARY KEY,
  mapping_id  BIGINT NOT NULL,
  order_id    BIGINT NOT NULL,
  INDEX idx_mapping (mapping_id),
  INDEX idx_order   (order_id)
) ENGINE=InnoDB;

INSERT INTO _t_target_deliveries (delivery_id, mapping_id, order_id)
SELECT od.id, od.order_product_mapping_id, opm.order_id
FROM order_delivery               od
INNER JOIN order_product_mapping  opm ON opm.id = od.order_product_mapping_id
INNER JOIN _t_target_orders       t   ON t.order_id = opm.order_id
INNER JOIN `order`                o   ON o.id = opm.order_id AND o.status = 'DELIVERY_COMPLETE'
WHERE od.delivery_target <> '-' OR od.original_delivery_target <> '-';

-- C2. early_destroy_request 감사 행 (주문당 1행, status=COMPLETED)
INSERT INTO early_destroy_request (
  order_id, client_company,
  contact_person, contact_email, sales_receipt,
  event_name, product_info, special_notes,
  desired_completion_date, reference_notes,
  status, requested_by, requested_at, executed_by, executed_at
)
SELECT DISTINCT
  td.order_id, @client_company,
  NULL, NULL, NULL,
  NULL, NULL, @special_notes,
  NULL, NULL,
  'COMPLETED', @actor_user_id, @run_at, @actor_user_id, @run_at
FROM _t_target_deliveries td;

-- C3. 방금 INSERT 한 request id 캐시
DROP TEMPORARY TABLE IF EXISTS _t_request_map;
CREATE TEMPORARY TABLE _t_request_map (
  request_id BIGINT NOT NULL PRIMARY KEY,
  order_id   BIGINT NOT NULL UNIQUE
) ENGINE=InnoDB;

INSERT INTO _t_request_map (request_id, order_id)
SELECT er.id, er.order_id
FROM early_destroy_request er
WHERE er.requested_at = @run_at
  AND er.requested_by = @actor_user_id
  AND er.status       = 'COMPLETED'
  AND er.order_id IN (SELECT order_id FROM _t_target_orders);

-- C4. early_destroy_request_item (매핑당 1행, order_delivery_id=NULL → 주문 단위)
INSERT INTO early_destroy_request_item (
  early_destroy_request_id, order_product_mapping_id, order_delivery_id
)
SELECT DISTINCT rm.request_id, td.mapping_id, NULL
FROM _t_target_deliveries td
INNER JOIN _t_request_map rm ON rm.order_id = td.order_id;

-- C5. order_delivery PII 5필드 마스킹
UPDATE order_delivery od
INNER JOIN _t_target_deliveries td ON td.delivery_id = od.id
SET
  od.delivery_target          = '-',
  od.original_delivery_target = '-',
  od.email_receiver_phone     = '-',
  od.bank_account             = '-',
  od.bank_account_owner       = '-';

-- C6. order_history 마스킹 — PII 보유 type 만 (C-1: couponStatus 감사기록 보존)
UPDATE order_history oh
INNER JOIN _t_target_deliveries td ON td.delivery_id = oh.order_delivery_id
SET
  oh.before_change = '-',
  oh.after_change  = '-'
WHERE oh.type IN ('수신정보 변경요청', '폐기 후 신규 발송');


-- =============================================================================
-- SECTION D. 사후 검증 — COMMIT 전 반드시 확인
-- =============================================================================

-- D1. 생성된 감사 요청 행 수 (예상: DELIVERY_COMPLETE 인 주문 수)
SELECT '[D1] requests_created' AS metric, COUNT(*) AS value FROM _t_request_map;

-- D2. 생성된 감사 항목 행 수 (예상: 대상 매핑 합)
SELECT '[D2] items_created' AS metric, COUNT(*) AS value
FROM early_destroy_request_item edri
INNER JOIN _t_request_map rm ON rm.request_id = edri.early_destroy_request_id;

-- D3. 마스킹된 발송건 수 (= _t_target_deliveries 행 수)
SELECT '[D3] deliveries_masked' AS metric, COUNT(*) AS value FROM _t_target_deliveries;

-- D4. 마스킹 후 PII 남은 발송건 (반드시 0)
SELECT '[D4] remaining_unmasked' AS metric, COUNT(*) AS value
FROM order_delivery od
INNER JOIN _t_target_deliveries td ON td.delivery_id = od.id
WHERE od.delivery_target          <> '-'
   OR od.original_delivery_target <> '-'
   OR od.email_receiver_phone     <> '-'
   OR od.bank_account             <> '-'
   OR od.bank_account_owner       <> '-';

-- D5. 스킵된 주문 (DELIVERY_COMPLETE 아니거나 이미 전부 파기되어 제외)
SELECT '[D5] skipped_orders' AS metric, t.order_id, o.status
FROM _t_target_orders t
LEFT JOIN `order`        o  ON o.id = t.order_id
LEFT JOIN _t_request_map rm ON rm.order_id = t.order_id
WHERE rm.request_id IS NULL;

-- D6. 주문별 처리 요약
SELECT t.order_id,
       rm.request_id,
       (SELECT COUNT(*) FROM _t_target_deliveries td WHERE td.order_id = t.order_id) AS deliveries_masked
FROM _t_target_orders t
LEFT JOIN _t_request_map rm ON rm.order_id = t.order_id
ORDER BY t.order_id;


-- =============================================================================
-- SECTION E. 최종 확정 — 둘 중 하나만 실행
-- =============================================================================
-- COMMIT;
-- ROLLBACK;


-- =============================================================================
-- SECTION F. 임시 테이블 정리 (COMMIT 또는 ROLLBACK 후)
-- =============================================================================
-- DROP TEMPORARY TABLE IF EXISTS _t_request_map;
-- DROP TEMPORARY TABLE IF EXISTS _t_target_deliveries;
-- DROP TEMPORARY TABLE IF EXISTS _t_target_orders;
