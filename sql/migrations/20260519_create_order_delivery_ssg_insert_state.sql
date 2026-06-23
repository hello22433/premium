-- order_delivery_ssg_insert_state — durable SSG INSERT state 신호 별 테이블
-- plans/ssg-balance-refactor.md PR1
--
-- 이전 안의 order_delivery.ssg_insert_state 컬럼은 폐기.
-- save(orderDelivery)가 메모리 stale 값으로 덮어쓸 위험(refundedAt과 동일 함정)을 피하기 위해
-- 신호 데이터를 별 테이블로 격리. order_delivery_refund ledger와 동일 패턴.
--
-- Lazy: row 없음 = NONE. enum 컬럼은 ATTEMPTED/CONFIRMED/FAILED 만 가짐.
-- 주문 생성 경로 수정 없음. markAttempted()가 최초 INSERT.
-- 현재 상태 1행만 유지 (transition history는 ssg_issue_log).

CREATE TABLE order_delivery_ssg_insert_state (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_delivery_id INT NOT NULL,
  state ENUM('ATTEMPTED', 'CONFIRMED', 'FAILED') NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_order_delivery_id (order_delivery_id),
  INDEX idx_state (state),
  CONSTRAINT fk_ssg_state_order_delivery FOREIGN KEY (order_delivery_id)
    REFERENCES order_delivery (id)
) COMMENT='SSG INSERT durable state 신호 (order_delivery.save() 덮어쓰기 영향권 외)';

-- ============================================================================
-- legacy backfill (SSG 주문 한정, Lazy 정책)
-- 분류 기준 (plans/ssg-balance-refactor.md PR1):
--   bar_code != NULL + status IN (COMPLETE, COMPLETE_SMS) → CONFIRMED row 생성
--   bar_code != NULL + status IN (FAIL, FAIL_SMS)        → ATTEMPTED row 생성 (자동 분류 위험, PR3 머지 전 검증)
--   bar_code  = NULL + ssg_issue_log 존재                → ATTEMPTED row 생성
--   그 외 (NONE 해당) → row 생성 안 함
-- ============================================================================

-- 1) CONFIRMED row 생성
INSERT INTO order_delivery_ssg_insert_state (order_delivery_id, state)
SELECT od.id, 'CONFIRMED'
FROM order_delivery od
JOIN order_product_mapping opm ON od.order_product_mapping_id = opm.id
JOIN `order` o ON opm.order_id = o.id
WHERE o.type = 'SSG'
  AND od.bar_code IS NOT NULL
  AND od.status IN ('COMPLETE', 'COMPLETE_SMS');

-- 2) ATTEMPTED row 생성: barCode 있으나 실패 상태
INSERT INTO order_delivery_ssg_insert_state (order_delivery_id, state)
SELECT od.id, 'ATTEMPTED'
FROM order_delivery od
JOIN order_product_mapping opm ON od.order_product_mapping_id = opm.id
JOIN `order` o ON opm.order_id = o.id
WHERE o.type = 'SSG'
  AND od.bar_code IS NOT NULL
  AND od.status IN ('FAIL', 'FAIL_SMS')
  AND NOT EXISTS (
    SELECT 1 FROM order_delivery_ssg_insert_state s WHERE s.order_delivery_id = od.id
  );

-- 3) ATTEMPTED row 생성: barCode NULL + ssg_issue_log 존재
INSERT INTO order_delivery_ssg_insert_state (order_delivery_id, state)
SELECT od.id, 'ATTEMPTED'
FROM order_delivery od
JOIN order_product_mapping opm ON od.order_product_mapping_id = opm.id
JOIN `order` o ON opm.order_id = o.id
WHERE o.type = 'SSG'
  AND od.bar_code IS NULL
  AND EXISTS (SELECT 1 FROM ssg_issue_log sil WHERE sil.order_delivery_id = od.id)
  AND NOT EXISTS (
    SELECT 1 FROM order_delivery_ssg_insert_state s WHERE s.order_delivery_id = od.id
  );

-- 검증 쿼리 (운영 적용 후 수동 실행):
-- SELECT state, COUNT(*) FROM order_delivery_ssg_insert_state GROUP BY state;
-- SELECT COUNT(*) FROM order_delivery od
-- JOIN order_product_mapping opm ON od.order_product_mapping_id = opm.id
-- JOIN `order` o ON opm.order_id = o.id
-- LEFT JOIN order_delivery_ssg_insert_state s ON s.order_delivery_id = od.id
-- WHERE o.type = 'SSG' AND s.id IS NULL;  -- NONE 해당 row 수
