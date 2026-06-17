-- SSG 상품 액면가(price) 유일성 보장 (audit #35)
-- 배경: findOrCreateSsgProductByPrice 의 존재검사~INSERT 구간이 트랜잭션/락/유니크 없이
--       TOCTOU 에 노출 → 동일 price SSG 상품 동시 생성(예: 생성 버튼 더블클릭) 시 중복 row 발생.
-- 방어: type='SSG' AND deleted_at IS NULL 인 row 에 한해 price 유일성을 DB 레벨에서 강제.
--       비-SSG(GENERAL/REAL 등) 및 soft-delete row 는 생성컬럼이 NULL → UNIQUE 가 다중 NULL 허용 → 충돌 없음.
--       (앱 레이어는 product.service.ts 에서 ER_DUP_ENTRY 발생 시 기존 row 재조회·반환으로 멱등 처리)
--
-- 적용 환경: MySQL 8.x (생성컬럼 + 온라인 INPLACE 인덱스). prod=MySQL 8.4.8 확인.
-- 적용 절차: sql/RUNBOOK.md (staging dry-run → RDS 스냅샷 → prod 적용).
--
-- ★ 적용 전 필수 점검 — 활성 중복이 있으면 ADD UNIQUE 가 ER_DUP_ENTRY 로 실패함.
--    아래 쿼리가 비어 있어야 ALTER 가 통과한다(중복 있으면 보존 row 외 soft-delete 후 재시도).
--    (2026-06-17 prod 점검 결과: 활성 127개 전부 유일, 중복 0 → 정리 불필요하게 통과)
--
--   SELECT price, COUNT(*) AS cnt, GROUP_CONCAT(id ORDER BY id) AS ids
--   FROM product
--   WHERE type = 'SSG' AND deleted_at IS NULL
--   GROUP BY price
--   HAVING cnt > 1;

ALTER TABLE product
  ADD COLUMN ssg_price_key INT
    GENERATED ALWAYS AS (CASE WHEN type = 'SSG' AND deleted_at IS NULL THEN price END) VIRTUAL,
  ADD UNIQUE KEY uq_product_ssg_price (ssg_price_key);

-- 검증
--   SHOW INDEX FROM product WHERE Key_name = 'uq_product_ssg_price';
--   SELECT id, price, type, ssg_price_key FROM product WHERE type='SSG' LIMIT 5;
--
-- 롤백
--   ALTER TABLE product DROP INDEX uq_product_ssg_price, DROP COLUMN ssg_price_key;
--
-- 주의: ssg_price_key 는 DB 전용 생성컬럼이며 ProductEntity 에는 추가하지 않는다.
--       (TypeORM 이 generated 컬럼에 INSERT 시도하면 깨지므로. save(newProduct) 는 이 컬럼을 건드리지 않음.)
