-- SSG INSERT state 컬럼 추가
-- plans/ssg-balance-refactor.md PR1
--
-- 신세계 행사 한도 = 발급 시도 누계 (gross 모델).
-- ePOPKON 측은 barCode/refundedAt에 INSERT 성공 의미를 과적재했고,
-- 그 결과 (1) NULL 덮어쓰기로 가드 누락, (2) orphan PIN(신세계 등록 + 우리 DB barCode NULL)
-- 같은 desync 상황에서 행사잔액 분기를 잘못 타게 되었다.
--
-- 이 컬럼은 INSERT 시도의 durable state를 표현하는 단일 신호로,
-- 이후 모든 SSG 행사잔액 보정 분기(refund/재발송)가 이 컬럼만 본다.
-- monotonic transition: NONE → ATTEMPTED → (CONFIRMED | FAILED). CONFIRMED/FAILED는 terminal.

ALTER TABLE order_delivery
  ADD COLUMN ssg_insert_state ENUM('NONE', 'ATTEMPTED', 'CONFIRMED', 'FAILED')
  NOT NULL DEFAULT 'NONE'
  COMMENT 'SSG INSERT durable state (NONE/ATTEMPTED/CONFIRMED/FAILED, monotonic)'
  AFTER ssg_event_id;

-- 운영 알림/배치 조회용 (ATTEMPTED 잔여 row 탐지)
CREATE INDEX idx_order_delivery_ssg_insert_state
  ON order_delivery (ssg_insert_state);

-- ============================================================================
-- legacy backfill (SSG 주문만 대상)
-- 분류 기준 (plans/ssg-balance-refactor.md PR1):
--   barCode != NULL + status IN (COMPLETE, COMPLETE_SMS)  → CONFIRMED
--   barCode != NULL + status IN (FAIL, FAIL_SMS)          → ATTEMPTED (자동 분류 위험, 검증 대상)
--   barCode  = NULL + ssg_issue_log 존재                  → ATTEMPTED
--   그 외 → NONE (DEFAULT)
--
-- FAIL_SMS = 알림톡 불가로 SMS 전환 후 SMS도 실패 (완전 실패 상태).
-- FAIL과 동일하게 INSERT 시도 후 실패한 row일 수 있어 ATTEMPTED 후보로 함께 포함.
-- ============================================================================

-- 1) CONFIRMED: 발급/발송 모두 성공한 케이스
UPDATE order_delivery od
JOIN order_product_mapping opm ON od.order_product_mapping_id = opm.id
JOIN `order` o ON opm.order_id = o.id
SET od.ssg_insert_state = 'CONFIRMED'
WHERE o.type = 'SSG'
  AND od.bar_code IS NOT NULL
  AND od.status IN ('COMPLETE', 'COMPLETE_SMS');

-- 2) ATTEMPTED: barCode 있으나 실패 상태 (INSERT 후 우리 코드 throw 가능성)
UPDATE order_delivery od
JOIN order_product_mapping opm ON od.order_product_mapping_id = opm.id
JOIN `order` o ON opm.order_id = o.id
SET od.ssg_insert_state = 'ATTEMPTED'
WHERE o.type = 'SSG'
  AND od.bar_code IS NOT NULL
  AND od.status IN ('FAIL', 'FAIL_SMS')
  AND od.ssg_insert_state = 'NONE';

-- 3) ATTEMPTED: barCode NULL + ssg_issue_log 존재 (INSERT 시도 기록 있음)
UPDATE order_delivery od
JOIN order_product_mapping opm ON od.order_product_mapping_id = opm.id
JOIN `order` o ON opm.order_id = o.id
JOIN ssg_issue_log sil ON sil.order_delivery_id = od.id
SET od.ssg_insert_state = 'ATTEMPTED'
WHERE o.type = 'SSG'
  AND od.bar_code IS NULL
  AND od.ssg_insert_state = 'NONE';

-- 검증 쿼리 (운영 적용 후 수동 실행):
-- SELECT ssg_insert_state, COUNT(*) FROM order_delivery od
-- JOIN order_product_mapping opm ON od.order_product_mapping_id = opm.id
-- JOIN `order` o ON opm.order_id = o.id
-- WHERE o.type = 'SSG'
-- GROUP BY ssg_insert_state;
