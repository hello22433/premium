-- =============================================================================
-- 수동 조기 개인정보파기 — 주문 2577 (단일 주문 전체 파기)
-- 일자: 2026-06-18
-- 사유: 고객사 요청 (조기파기 기능 미배포 상태에서 수동 처리)
-- 대상: order 2577 (https://premium.epopkon.com/order/general/detail/2577)
--
-- 동작 (EarlyDestroyService.executeRequest + createRequestForOrder 와 동일):
--   1. early_destroy_request          (주문당 1행, status=COMPLETED)
--   2. early_destroy_request_item     (매핑당 1행, order_delivery_id=NULL → 주문 단위 파기)
--   3. order_delivery PII 5필드 마스킹 = '-'
--        delivery_target / original_delivery_target / email_receiver_phone /
--        bank_account / bank_account_owner
--   4. order_history before_change / after_change = '-'
--        ⚠️ 단, type IN ('수신정보 변경요청','폐기 후 신규 발송') 인 행만.
--        그 외 type(폐기/환불폐기/핀상태 변경 등)의 before/after 는 couponStatus
--        전이 감사값이므로 마스킹 금지 (C-1). ← 2026-05-08 수동 SQL 과의 유일한 차이.
--
-- 안전장치:
--   - 모든 변경은 START TRANSACTION 안에서 일어남
--   - order.status = 'DELIVERY_COMPLETE' 아니면 C 에서 0건 처리 → D5 에서 보고
--   - 이미 '-' 로 마스킹된 발송건은 대상에서 제외 (멱등성)
--   - 환불 PROGRESS/APPROVE 발송건은 B2 에서 사전 보고 → 발견 시 ROLLBACK
--
-- 사용법: 섹션 순서대로 실행. C 실행 후 D 검증 → 정상이면 COMMIT, 아니면 ROLLBACK.
-- =============================================================================


-- =============================================================================
-- SECTION A. 파라미터
-- =============================================================================
-- ⚠️ 실행 전 반드시 채울 것
SET @order_id       = 2577;
SET @actor_user_id  = 7;                  -- 실행 관리자 user.id (2026-05-08 건은 development@enmad.com = 7)
SET @client_company = '펑타이그레이터차이나 유한회사';          -- 실제 고객사명으로 교체
SET @run_at         = NOW();
SET @special_notes  = '고객사 요청 수동 조기파기 (2026-06-18)';

SELECT '[A0] params' AS info, @order_id AS order_id, @actor_user_id AS actor,
       @client_company AS client_company, @run_at AS run_at;


-- =============================================================================
-- SECTION B. 사전 검증 — 실행 전 사람 눈으로 확인
-- =============================================================================

-- B1. 주문 상태 (DELIVERY_COMPLETE 아니면 파기 불가)
SELECT o.id AS order_id, o.status, o.user_id AS order_owner_user_id, o.created_at
FROM `order` o
WHERE o.id = @order_id;

-- B2. 환불 진행/승인 중인 발송건 — 1건이라도 나오면 절대 COMMIT 금지
SELECT od.id AS delivery_id, opm.order_id, od.refund_status,
       od.refund_register_at, od.approve_at
FROM order_delivery od
INNER JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
WHERE opm.order_id = @order_id
  AND od.refund_status IN ('PROGRESS', 'APPROVE');

-- B3. 파기 대상 발송건 카운트 (이미 '-' 처리된 건 제외)
SELECT COALESCE(SUM(CASE
         WHEN od.delivery_target          <> '-'
           OR od.original_delivery_target <> '-' THEN 1 ELSE 0 END), 0) AS to_destroy_cnt,
       COALESCE(SUM(CASE
         WHEN od.delivery_target           = '-'
          AND od.original_delivery_target  = '-' THEN 1 ELSE 0 END), 0) AS already_destroyed_cnt
FROM `order` o
INNER JOIN order_product_mapping opm ON opm.order_id = o.id
INNER JOIN order_delivery        od  ON od.order_product_mapping_id = opm.id
WHERE o.id = @order_id
  AND o.status = 'DELIVERY_COMPLETE';

-- B4. 매핑(상품) 카운트
SELECT COUNT(opm.id) AS mapping_count
FROM order_product_mapping opm
WHERE opm.order_id = @order_id;


-- =============================================================================
-- SECTION C. 트랜잭션 — 실제 INSERT / UPDATE
--   B 결과 확인 후 이상 없을 때만 실행
-- =============================================================================
START TRANSACTION;

-- C1. 파기 대상 발송건 캐시 (status=DELIVERY_COMPLETE 인 경우만, 미마스킹 행만)
DROP TEMPORARY TABLE IF EXISTS _t_target_deliveries;
CREATE TEMPORARY TABLE _t_target_deliveries (
  delivery_id BIGINT NOT NULL PRIMARY KEY,
  mapping_id  BIGINT NOT NULL,
  INDEX idx_mapping (mapping_id)
) ENGINE=InnoDB;

INSERT INTO _t_target_deliveries (delivery_id, mapping_id)
SELECT od.id, od.order_product_mapping_id
FROM order_delivery               od
INNER JOIN order_product_mapping  opm ON opm.id = od.order_product_mapping_id
INNER JOIN `order`                o   ON o.id = opm.order_id AND o.status = 'DELIVERY_COMPLETE'
WHERE opm.order_id = @order_id
  AND (od.delivery_target <> '-' OR od.original_delivery_target <> '-');

-- C2. early_destroy_request 감사 행 (주문당 1행, status=COMPLETED)
--     대상 발송건이 0이면 INSERT 0건 → 아무 변경 없음(멱등)
INSERT INTO early_destroy_request (
  order_id, client_company,
  contact_person, contact_email, sales_receipt,
  event_name, product_info, special_notes,
  desired_completion_date, reference_notes,
  status, requested_by, requested_at, executed_by, executed_at
)
SELECT @order_id, @client_company,
       NULL, NULL, NULL,
       NULL, NULL, @special_notes,
       NULL, NULL,
       'COMPLETED', @actor_user_id, @run_at, @actor_user_id, @run_at
WHERE EXISTS (SELECT 1 FROM _t_target_deliveries);

SET @request_id = LAST_INSERT_ID();

-- C3. early_destroy_request_item (매핑당 1행, order_delivery_id=NULL → 주문 단위)
INSERT INTO early_destroy_request_item (
  early_destroy_request_id, order_product_mapping_id, order_delivery_id
)
SELECT DISTINCT @request_id, td.mapping_id, NULL
FROM _t_target_deliveries td
WHERE @request_id IS NOT NULL;

-- C4. order_delivery PII 5필드 마스킹
UPDATE order_delivery od
INNER JOIN _t_target_deliveries td ON td.delivery_id = od.id
SET
  od.delivery_target          = '-',
  od.original_delivery_target = '-',
  od.email_receiver_phone     = '-',
  od.bank_account             = '-',
  od.bank_account_owner       = '-';

-- C5. order_history 마스킹 — PII 보유 type 만 (C-1: couponStatus 감사기록 보존)
UPDATE order_history oh
INNER JOIN _t_target_deliveries td ON td.delivery_id = oh.order_delivery_id
SET
  oh.before_change = '-',
  oh.after_change  = '-'
WHERE oh.type IN ('수신정보 변경요청', '폐기 후 신규 발송');


-- =============================================================================
-- SECTION D. 사후 검증 — COMMIT 전 반드시 확인
-- =============================================================================

-- D1. 생성된 감사 요청 (예상: 1건, 단 DELIVERY_COMPLETE & 미파기 발송건 존재 시)
SELECT '[D1] request_id' AS metric, @request_id AS value;

-- D2. 생성된 감사 항목 행 수 (예상: 대상 매핑 수)
SELECT '[D2] items_created' AS metric, COUNT(*) AS value
FROM early_destroy_request_item
WHERE early_destroy_request_id = @request_id;

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

-- D5. 스킵 여부 (NULL = 처리됨, request_id 없으면 DELIVERY_COMPLETE 아니거나 이미 전부 파기)
SELECT '[D5] order_status' AS metric, o.status, @request_id AS request_id
FROM `order` o WHERE o.id = @order_id;


-- =============================================================================
-- SECTION E. 최종 확정 — 둘 중 하나만 실행
-- =============================================================================
-- COMMIT;
-- ROLLBACK;


-- =============================================================================
-- SECTION F. 임시 테이블 정리 (COMMIT 또는 ROLLBACK 후)
-- =============================================================================
-- DROP TEMPORARY TABLE IF EXISTS _t_target_deliveries;
