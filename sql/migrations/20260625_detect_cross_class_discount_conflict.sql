-- 교차 분류(CATEGORY ↔ PRODUCT_GROUP) 할인/할증 방향 충돌 탐지 및 배포 체크리스트
-- ============================================================================
-- 배경:
--   discount.matcher.ts 의 findMatchingDiscount() 는 동일 대상(userId/partnerCompanyId)에
--   CATEGORY 할인과 PRODUCT_GROUP 할인이 동시에 매칭되고 priceAdjustment 방향이 다를 경우
--   BadRequestException('카테고리 할인과 상품군 할인/할증 정책이 충돌합니다.')을 던진다.
--
--   이번 픽스(#23)에서 create() 시점에 validateCrossClassConflict()로 신규 충돌 등록을 차단했으나,
--   픽스 배포 이전에 이미 저장된 충돌 조합이 존재할 경우 정산 API / 협력사 정산 목록 등에서
--   런타임 400이 발생할 수 있다.
--
-- ============================================================================
-- [배포 전 Step 1] 충돌 행 탐지 — 결과가 0건이어야 배포 가능
-- ============================================================================
-- 실행 후 결과가 1건 이상이면:
--   1) 아래 결과를 담당자에게 공유
--   2) 어느 방향(DISCOUNT/ADDITIONAL)을 유지할지 비즈니스 확인
--   3) 제거 대상 id를 확인 후 [Step 2] soft-delete 실행
--   4) soft-delete 완료 후 [Step 1] 재실행 → 0건 확인 → 배포 진행

SELECT
  a.id                  AS category_discount_id,
  a.user_id,
  a.partner_company_id,
  a.category            AS category_type,
  a.price_adjustment    AS category_direction,
  a.price_percent       AS category_percent,
  b.id                  AS group_discount_id,
  b.category            AS group_type,
  b.price_adjustment    AS group_direction,
  b.price_percent       AS group_percent
FROM user_discount a
JOIN user_discount b
  ON (
       (a.user_id IS NOT NULL              AND a.user_id = b.user_id
        AND a.partner_company_id IS NULL   AND b.partner_company_id IS NULL)
    OR (a.partner_company_id IS NOT NULL   AND a.partner_company_id = b.partner_company_id
        AND a.user_id IS NULL              AND b.user_id IS NULL)
  )
WHERE a.category       = 'CATEGORY'
  AND b.category       = 'PRODUCT_GROUP'
  AND a.price_adjustment != b.price_adjustment
  AND a.deleted_at IS NULL
  AND b.deleted_at IS NULL
ORDER BY a.user_id, a.partner_company_id, a.id;

-- ============================================================================
-- [배포 전 Step 2] 충돌 행 soft-delete (Step 1 결과가 1건 이상일 때만 실행)
-- ============================================================================
-- ※ 자동화하지 않은 이유:
--   충돌 쌍에서 어느 쪽(CATEGORY/PRODUCT_GROUP)을 제거할지는 코드가 결정할 수 없다.
--   pricePercent 같은 임의 기준으로 자동 삭제하면 할인/할증 방향이 역전되어
--   정산 금액이 잘못 계산될 수 있다. 해당 고객사 계약 조건을 담당자가 확인 후
--   올바른 행을 직접 지정해야 한다.
--
-- 제거 대상 id를 Step 1 결과에서 확인 후 아래 쿼리의 IN(...) 에 채워 실행.
-- soft-delete이므로 롤백 필요 시: UPDATE user_discount SET deleted_at = NULL WHERE id IN (...);

-- UPDATE user_discount
--   SET deleted_at = NOW()
-- WHERE id IN (/* Step 1 결과에서 제거할 id */);

-- ============================================================================
-- [배포 후 Step 3] 충돌 신규 등록 차단 검증 — 결과가 0건이어야 정상
-- ============================================================================

SELECT COUNT(*) AS conflict_count
FROM user_discount a
JOIN user_discount b
  ON (
       (a.user_id IS NOT NULL              AND a.user_id = b.user_id
        AND a.partner_company_id IS NULL   AND b.partner_company_id IS NULL)
    OR (a.partner_company_id IS NOT NULL   AND a.partner_company_id = b.partner_company_id
        AND a.user_id IS NULL              AND b.user_id IS NULL)
  )
WHERE a.category       = 'CATEGORY'
  AND b.category       = 'PRODUCT_GROUP'
  AND a.price_adjustment != b.price_adjustment
  AND a.deleted_at IS NULL
  AND b.deleted_at IS NULL;
