-- 상품 수정 이력 값 컬럼을 TEXT 로 확장한다.
--
-- 배경
--   유의사항(product.memo)은 상용 기준 varchar(4000)이고 실제 값도 이미 1300자를 넘는 상품이 있다.
--   그런데 이력 테이블의 before_value / after_value 는 varchar(512) 라, 유의사항을 수정하면
--   수정 전·후 문구가 잘려 들어가(또는 strict 모드에서 에러가 나서) 되돌릴 근거가 사라진다.
--   신세계 유의사항 수정 화면은 이 이력이 유일한 롤백 근거이므로 먼저 넓혀야 한다.
--
-- 실행 순서
--   이 DDL 을 먼저 실행하고 그 다음에 코드를 배포한다.
--   컬럼 확장은 하위호환이라 기존 코드에 아무 영향이 없다.
--
-- 재실행 안전: 이미 TEXT 여도 같은 결과다(데이터 변경 없음).

-- ─────────────────────────────────────────────────────────────
-- 0) 현재 상태 확인
-- ─────────────────────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'product_update_history'
  AND COLUMN_NAME IN ('before_value', 'after_value');

-- 잘려 저장됐을 가능성이 있는 기존 이력(참고용). 512자 꽉 찬 행이 있으면 그 시점 값은 이미 손실된 것이다.
SELECT COUNT(*) AS maybe_truncated_cnt
FROM product_update_history
WHERE CHAR_LENGTH(before_value) = 512
   OR CHAR_LENGTH(after_value) = 512;

-- ─────────────────────────────────────────────────────────────
-- 1) 컬럼 확장
-- ─────────────────────────────────────────────────────────────
ALTER TABLE product_update_history
  MODIFY COLUMN before_value TEXT NULL COMMENT '변경 전 value',
  MODIFY COLUMN after_value  TEXT NULL COMMENT '변경 후 value';

-- ─────────────────────────────────────────────────────────────
-- 2) 검증 — 두 컬럼이 text 로 바뀌었는지
-- ─────────────────────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'product_update_history'
  AND COLUMN_NAME IN ('before_value', 'after_value');

-- product.memo 가 엔티티 선언(varchar 4000)과 같은지도 함께 확인한다. 다르면 알려줄 것.
SELECT COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'product'
  AND COLUMN_NAME = 'memo';

-- ─────────────────────────────────────────────────────────────
-- 3) 롤백 (필요 시에만)
--    ⚠ 512자를 넘는 이력이 이미 쌓였다면 되돌리는 순간 잘린다. 먼저 0)의 길이 확인을 할 것.
-- ─────────────────────────────────────────────────────────────
-- ALTER TABLE product_update_history
--   MODIFY COLUMN before_value VARCHAR(512) NULL COMMENT '변경 전 value',
--   MODIFY COLUMN after_value  VARCHAR(512) NULL COMMENT '변경 후 value';
