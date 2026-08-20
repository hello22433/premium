-- =============================================================================
-- Backfill: order_product_mapping.snapshot_product_category / snapshot_product_classification_id
-- =============================================================================
-- 배경
--   20260803_partner_credit_pr1a_discount_history.sql 이 snapshot_product_category /
--   snapshot_product_classification_id 컬럼을 추가하면서, 그 마이그레이션 자체는 의도적으로
--   레거시 row 를 채우지 않았다(같은 파일 §4 주석: "레거시 row 는 live product 조인으로 채우지
--   않는다(과거 정산 변동 금지)"). 이 스크립트가 그 후속 백필이며,
--   20260615_backfill_order_product_mapping_snapshot.sql 이 snapshot_product_price 에 대해
--   이미 같은 패턴(라이브 product 폴백)을 썼던 선례를 따른다.
--
--   대상 범위: order_product_mapping.snapshot_product_category IS NULL 인 전체 row.
--   partner_settle_ledger 원인 조사 결과 이 상태가 PRICE_UNRECOVERABLE(NEEDS_REVIEW) 원장
--   543건의 원인이었다. 전량이 (a) 2026-08-04 13:25 컬럼 도입 이전 생성된 주문(481건) 또는
--   (b) 도입 직후 배포 지연 창(2026-08-04 17:28~2026-08-06 17:56 사이 생성, 68건)에 해당했다.
--   2026-08-06 18:00 이후 생성된 주문에서는 이 문제가 재현되지 않음 — 코드는 정상.
--
-- 드리프트 리스크 검증
--   product.updated_at 이 2026-08-12 에 세 그룹(13:37대/15:10대/18:06대)으로 몰려 찍혀 있어,
--   그 사이 category 값 자체가 바뀌었을 가능성을 먼저 의심했다. 원인 확인 결과 이 시각들은
--   상품 엑셀 일괄업로드 경로(product.service.ts updatePartial, 약 1613~1632행)가 남긴 흔적이며,
--   이 경로는 매 행마다 전체 컬럼(category/price/type/... 포함)을 스프레드시트 값으로 통째로
--   재기록한다(부분 diff 업데이트가 아님) — 그래서 실제로 손대지 않은 컬럼도 updated_at 이
--   같이 찍힌다. 담당자 확인 결과 해당 업로드는 상품 설명(memo)만 변경 목적이었고 가격·상품군은
--   그대로 유지했다고 확인됨. product 변경이력 테이블이 없어 독립적으로 재검증할 수는 없지만,
--   코드 경로 분석(전체행 재기록 방식이라 무변경 컬럼도 timestamp 만 갱신됨)과 담당자 증언이
--   서로 모순 없이 들어맞아 category 값 자체는 바뀌지 않은 것으로 판단했다.
--
-- 범위
--   order_product_mapping 의 snapshot 컬럼만 채운다. partner_settle_ledger(append-only 원장)는
--   건드리지 않는다 — 기존 NEEDS_REVIEW 원장 543건 해소는 이 백필과 별개로 정식 review-resolution
--   경로(POST /settle/ledger/needs-review/resolve/propose → /approve, resolutionMode=RECLASSIFY)를
--   통해 진행한다. 이 스크립트는 그 재계산이 올바른 category 를 입력받도록 선행 정리하는 것뿐이다.
--
-- 실행 순서: dev 먼저 → 아래 건수 확인 → prod. 멱등(대상 컬럼이 NULL 인 row 만 갱신, 재실행 안전).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- (선택) 실행 전 영향 범위 확인 — 몇 건이 갱신 대상인지 미리 본다.
-- ---------------------------------------------------------------------------
-- SELECT COUNT(*) AS target_rows
-- FROM order_product_mapping opm
-- JOIN product p ON p.id = opm.product_id
-- WHERE opm.snapshot_product_category IS NULL
--    OR opm.snapshot_product_classification_id IS NULL;


-- ---------------------------------------------------------------------------
-- 백필 본체
-- ---------------------------------------------------------------------------
UPDATE order_product_mapping opm
JOIN product p ON p.id = opm.product_id
SET
  opm.snapshot_product_category          = COALESCE(opm.snapshot_product_category, p.category),
  opm.snapshot_product_classification_id = COALESCE(opm.snapshot_product_classification_id, p.classification_id)
WHERE
     opm.snapshot_product_category IS NULL
  OR opm.snapshot_product_classification_id IS NULL;


-- ---------------------------------------------------------------------------
-- (선택) 실행 후 검증 — 0건이어야 정상 종료.
-- ---------------------------------------------------------------------------
-- SELECT COUNT(*) AS still_null
-- FROM order_product_mapping
-- WHERE snapshot_product_category IS NULL;
