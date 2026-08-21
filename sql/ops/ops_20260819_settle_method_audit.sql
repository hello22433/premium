-- ============================================================================
-- O4 settleMethod 정합성 검증 및 정정
-- 목적: PR1E backfill·opening 전 상품별 settleMethod 가 계약 기준과 일치하는지 검증
-- 작성: 2026-08-19
-- ============================================================================
-- 실행 순서:
--   STEP 1  현황 집계 (읽기 전용) → 오설정 후보 식별
--   STEP 2  오설정 후보 상세 조회 (읽기 전용) → 정정 대상 확정
--   STEP 3  정정 SQL (트랜잭션) → 사용자 확인 후 실행
--   STEP 4  정정 후 검증 (읽기 전용)
-- ============================================================================

-- ============================================================================
-- STEP 1: 협력사별 settleMethod 분포 현황
-- ============================================================================

-- 1-1. 협력사 type별 × settleMethod별 상품 수 (삭제 안 된 것만)
SELECT
  pc.type        AS partner_type,
  p.settle_method,
  COUNT(*)       AS product_count
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE p.deleted_at IS NULL
GROUP BY pc.type, p.settle_method
ORDER BY pc.type, p.settle_method;

-- 1-2. 한국문화진흥(CULTURELAND) — 전 상품 PER_ISSUANCE 여야 함. PER_EXCHANGE 등 이탈 건 확인
SELECT
  p.id, p.code, p.name, p.settle_method, p.use_status,
  pc.business_name
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE pc.type = 'CULTURELAND'
  AND p.deleted_at IS NULL
  AND p.settle_method <> 'PER_ISSUANCE';

-- 1-3. PER_PRODUCT 가 갤럭시아 외에 존재하면 안 됨 (0건이어야 정상)
SELECT
  pc.type, p.id, p.code, p.name, p.settle_method
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE p.deleted_at IS NULL
  AND p.settle_method = 'PER_PRODUCT'
  AND pc.type <> 'GALAXIA';

-- 1-4. 갤럭시아(GALAXIA) settleMethod 분포 — 업무 기준: 사용금액 87 / 교환 31 / 발행 19
--   PER_PRODUCT = 사용금액 기준 (87건 기대)
--   PER_EXCHANGE = 교환 기준 (31건 기대, dept 상품 등)
--   PER_ISSUANCE = 발행 기준 (19건 기대)
SELECT
  p.settle_method,
  COUNT(*) AS cnt
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE pc.type = 'GALAXIA'
  AND p.deleted_at IS NULL
GROUP BY p.settle_method;

-- 1-5. 갤럭시아 상품 전체 목록 (settleMethod 포함) — 업무 기준 매핑 대조용
SELECT
  p.id, p.code, p.partner_company_code, p.name, p.price,
  p.settle_method, p.category, p.use_status,
  b.name AS brand_name, b.code AS brand_code
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
LEFT JOIN brand b ON b.id = p.brand_id
WHERE pc.type = 'GALAXIA'
  AND p.deleted_at IS NULL
ORDER BY p.settle_method, p.code;

-- 1-6. 전체 협력사별 settleMethod 요약 (참고용)
SELECT
  pc.type        AS partner_type,
  pc.business_name,
  p.settle_method,
  COUNT(*)       AS cnt,
  GROUP_CONCAT(p.code ORDER BY p.code SEPARATOR ', ') AS product_codes
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE p.deleted_at IS NULL
GROUP BY pc.type, pc.business_name, p.settle_method
ORDER BY pc.type, p.settle_method;


-- ============================================================================
-- STEP 2: 오설정 후보 상세 (STEP 1 결과 확인 후 아래 WHERE 조건 조정)
-- ============================================================================

-- 2-1. 한국문화진흥 PER_EXCHANGE 1건 상세
SELECT
  p.id, p.code, p.partner_company_code, p.name, p.price,
  p.settle_method, p.settle_percent, p.expire_day,
  p.use_status, p.type AS product_type,
  p.created_at, p.updated_at
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE pc.type = 'CULTURELAND'
  AND p.deleted_at IS NULL
  AND p.settle_method <> 'PER_ISSUANCE';

-- 2-2. 갤럭시아 — STEP 1-4 결과가 87/31/19 와 다르면 여기서 불일치 상품 식별
--      (아래는 예시 — 실제 업무 매핑표 대조 후 product.id 를 특정해야 함)
--      → 업무팀에서 "이 상품코드는 사용금액/교환/발행" 매핑표를 받은 뒤
--        아래 CASE WHEN 의 code 목록을 채워서 diff 를 내는 구조
/*
SELECT
  p.id, p.code, p.name,
  p.settle_method AS current_method,
  CASE
    WHEN p.code IN ('<교환 상품 코드 목록>') THEN 'PER_EXCHANGE'
    WHEN p.code IN ('<발행 상품 코드 목록>') THEN 'PER_ISSUANCE'
    ELSE 'PER_PRODUCT'
  END AS expected_method
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE pc.type = 'GALAXIA'
  AND p.deleted_at IS NULL
HAVING current_method <> expected_method;
*/


-- ============================================================================
-- STEP 3: 정정 SQL (트랜잭션으로 실행, 사용자 확인 후)
-- ============================================================================
-- 아래는 확정된 오설정에 대한 정정 템플릿.
-- STEP 2 결과로 product.id 가 확정되면 아래 @product_id, @correct_method 를 채운다.

-- ── 3-A. 한국문화진흥 PER_EXCHANGE → PER_ISSUANCE 정정 ──────────────────────

-- 정정 대상 product.id 확인 (STEP 2-1 결과에서 가져옴)
-- SET @target_product_id = ???;
-- SET @admin_user_id = ???;  -- 정정 실행 관리자 user.id

/*
START TRANSACTION;

-- 변경 이력 기록
INSERT INTO product_update_history
  (user_id, product_id, `key`, key_name, before_value, after_value, reason, created_at, updated_at)
SELECT
  @admin_user_id,
  p.id,
  'settleMethod',
  '정산 방법',
  p.settle_method,
  'PER_ISSUANCE',
  '[O4] 한국문화진흥 전 상품 발행 기준 계약 대조 — 오설정 정정',
  NOW(),
  NOW()
FROM product p
WHERE p.id = @target_product_id
  AND p.settle_method <> 'PER_ISSUANCE';

-- settleMethod 정정
UPDATE product
SET settle_method = 'PER_ISSUANCE',
    updated_at = NOW()
WHERE id = @target_product_id
  AND settle_method <> 'PER_ISSUANCE';

-- 영향 행 수 확인 (INSERT 1, UPDATE 1 이어야 함)
SELECT ROW_COUNT() AS updated_rows;

COMMIT;
*/

-- ── 3-B. 갤럭시아 오설정 정정 (대상 확정 후) ──────────────────────────────
-- 갤럭시아는 상품별로 올바른 settleMethod 가 다르므로 (PER_PRODUCT/PER_EXCHANGE/PER_ISSUANCE)
-- 업무 매핑표 대조 후 건별로 아래 패턴을 반복한다.

/*
START TRANSACTION;

-- 예시: product.id = ??? 를 PER_EXCHANGE → PER_PRODUCT 로 정정
SET @target_product_id = ???;
SET @admin_user_id = ???;
SET @correct_method = 'PER_PRODUCT';  -- 계약 기준 올바른 값

INSERT INTO product_update_history
  (user_id, product_id, `key`, key_name, before_value, after_value, reason, created_at, updated_at)
SELECT
  @admin_user_id,
  p.id,
  'settleMethod',
  '정산 방법',
  p.settle_method,
  @correct_method,
  '[O4] 갤럭시아 계약 기준 정산방법 대조 — 오설정 정정',
  NOW(),
  NOW()
FROM product p
WHERE p.id = @target_product_id
  AND p.settle_method <> @correct_method;

UPDATE product
SET settle_method = @correct_method,
    updated_at = NOW()
WHERE id = @target_product_id
  AND settle_method <> @correct_method;

SELECT ROW_COUNT() AS updated_rows;

COMMIT;
*/

-- ── 3-C. 복수 건 일괄 정정 템플릿 (대상 목록 확정 후) ──────────────────────
-- product_id → correct_method 매핑이 확정되면 아래처럼 일괄 처리 가능

/*
START TRANSACTION;

SET @admin_user_id = ???;
SET @reason = '[O4] 협력사 계약 기준 settleMethod 일괄 정정 (PR1E 선행)';

-- 정정 대상 임시 테이블 (실행 시 값 채움)
CREATE TEMPORARY TABLE tmp_settle_method_fix (
  product_id INT NOT NULL,
  correct_method VARCHAR(50) NOT NULL
);

INSERT INTO tmp_settle_method_fix (product_id, correct_method) VALUES
  -- (product_id, 'PER_ISSUANCE'),
  -- (product_id, 'PER_EXCHANGE'),
  -- ...
;

-- 변경 이력 일괄 기록
INSERT INTO product_update_history
  (user_id, product_id, `key`, key_name, before_value, after_value, reason, created_at, updated_at)
SELECT
  @admin_user_id,
  p.id,
  'settleMethod',
  '정산 방법',
  p.settle_method,
  f.correct_method,
  @reason,
  NOW(),
  NOW()
FROM product p
JOIN tmp_settle_method_fix f ON f.product_id = p.id
WHERE p.settle_method <> f.correct_method;

-- settleMethod 일괄 정정
UPDATE product p
JOIN tmp_settle_method_fix f ON f.product_id = p.id
SET p.settle_method = f.correct_method,
    p.updated_at = NOW()
WHERE p.settle_method <> f.correct_method;

SELECT ROW_COUNT() AS updated_rows;

DROP TEMPORARY TABLE tmp_settle_method_fix;

COMMIT;
*/


-- ============================================================================
-- STEP 4: 정정 후 검증
-- ============================================================================

-- 4-1. 정정 후 분포 재확인 (STEP 1-1 재실행)
SELECT
  pc.type        AS partner_type,
  p.settle_method,
  COUNT(*)       AS product_count
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE p.deleted_at IS NULL
GROUP BY pc.type, p.settle_method
ORDER BY pc.type, p.settle_method;

-- 4-2. 한국문화진흥 비 PER_ISSUANCE = 0건 확인
SELECT COUNT(*) AS cultureland_non_issuance
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE pc.type = 'CULTURELAND'
  AND p.deleted_at IS NULL
  AND p.settle_method <> 'PER_ISSUANCE';

-- 4-3. PER_PRODUCT 가 갤럭시아 외 = 0건 확인
SELECT COUNT(*) AS non_galaxia_per_product
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE p.deleted_at IS NULL
  AND p.settle_method = 'PER_PRODUCT'
  AND pc.type <> 'GALAXIA';

-- 4-4. 변경 이력 확인 (오늘 날짜 기준)
SELECT
  puh.id, puh.product_id, puh.before_value, puh.after_value, puh.reason,
  p.code, p.name, pc.type AS partner_type
FROM product_update_history puh
JOIN product p ON p.id = puh.product_id
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE puh.key = 'settleMethod'
  AND DATE(puh.created_at) = CURDATE()
ORDER BY puh.id;

-- 4-5. sourceType 매핑 검증 (코드 resolveSourceType 과 동일 로직)
--      정정된 상품이 올바른 sourceType 으로 원장에 잡히는지 확인
SELECT
  pc.type AS partner_type,
  p.code, p.name, p.settle_method,
  CASE p.settle_method
    WHEN 'PER_ISSUANCE' THEN 'ISSUANCE'
    WHEN 'PER_EXCHANGE' THEN 'EXCHANGE'
    WHEN 'PER_PRODUCT'  THEN 'USAGE'
    WHEN 'PREPAID_INVENTORY' THEN 'EXCLUDED'
    ELSE 'UNKNOWN'
  END AS expected_source_type
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE p.deleted_at IS NULL
  AND pc.type IN ('CULTURELAND', 'GALAXIA', 'DAOU', 'GIFT_SHOW', 'GIFTIEL', 'SSG')
ORDER BY pc.type, p.settle_method, p.code;
