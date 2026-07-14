-- =====================================================================
-- [진단 전용 / 읽기] 정산방법(settleMethod) SoT 불일치 + 할인 자동적용 점검
-- 대상 사례: 한국갤럽조사연구소 (현금 정산인데 정산정보입력에 카드/카드할증 자동선택)
--            + 발송건 할인 자동적용 누락
-- 실행 시점: WALLET_PR3_SETTLE_MODE=wallet 운영 기준.
-- 주의: 모두 SELECT (변경 없음). 4번 교정 UPDATE 는 주석 처리 — 결과 확인 후 수동 실행.
-- 참고: 정산 읽기 SoT = wallet_account.settle_method (settlement_code 단위 공유).
--       계정관리 표시는 이제 동일 SoT 를 따른다(getDetail resolveEffectiveSettleMethod).
-- =====================================================================

-- ── 1. 고객사 계정 ↔ company ↔ wallet 의 settle_method 3원 비교 ──
--    user.settle_method(deprecated) / user_company.settle_method / wallet_account.settle_method
--    셋이 다르면 그 차이가 곧 "계정관리엔 현금, 정산엔 카드" 증상의 원인.
SELECT
  u.id                         AS user_id,
  u.email,
  uc.business_name,
  u.settlement_code,
  u.settle_method              AS user_settle_method,      -- deprecated
  uc.settle_method             AS company_settle_method,   -- LEGACY SoT
  wa.settle_method             AS wallet_settle_method,    -- WALLET SoT (실제 정산 사용)
  wa.owner_id                  AS wallet_owner
FROM user u
LEFT JOIN user_company uc  ON uc.id = u.company_id
LEFT JOIN wallet_account wa ON wa.owner_type = 'SETTLEMENT_CODE' AND wa.owner_id = u.settlement_code
WHERE u.deleted_at IS NULL
  AND uc.business_name LIKE '%갤럽%'
ORDER BY u.id;

-- ── 2. 이 계정의 settlement_code 가 다른 계정과 "공유" 되는지 확인 ──
--    2건 이상이면 공유 정산코드 → wallet.settle_method 를 바꾸면 그 코드의 모든 계정에 영향.
--    (1번 결과의 settlement_code 값을 아래 :code 자리에 넣어 실행)
SELECT
  u.settlement_code,
  COUNT(*)                                       AS active_user_count,
  GROUP_CONCAT(u.id ORDER BY u.id)               AS user_ids,
  GROUP_CONCAT(DISTINCT u.settle_method)         AS user_methods,
  MAX(wa.settle_method)                          AS wallet_settle_method
FROM user u
LEFT JOIN wallet_account wa ON wa.owner_type = 'SETTLEMENT_CODE' AND wa.owner_id = u.settlement_code
WHERE u.deleted_at IS NULL
  AND u.settlement_code = 'company-1'    -- ← 1번 결과의 settlement_code 로 교체
GROUP BY u.settlement_code;

-- ── 3. [이슈1] 발송건 할인 자동적용 조건 점검 ──
--    자동적용(findMatchingDiscount)은 (fee IS NULL OR price_adjustment IS NULL)
--    AND 주문상태가 발송확정/완료가 아닐 때만 동작. 아래로 어느 조건에 걸렸는지 확정.
--    (해당 주문 id 를 :orderId 에 넣어 실행. 발송관리 목록에서 확인 가능)
SELECT
  o.id                     AS order_id,
  o.status                 AS order_status,          -- DELIVERY_CONFIRMED/COMPLETE 이면 자동적용 차단(정상)
  o.user_id,
  o.client_user_id,                                  -- 대행주문이면 할인 기준 = client_user_id
  COALESCE(o.client_user_id, o.user_id) AS billing_user_id,
  o.settle_method          AS order_settle_method,   -- NULL 이면 미입력 → 정책 폴백
  o.card_surcharge_applied,
  opm.id                   AS mapping_id,
  opm.product_id,
  opm.amount,
  opm.fee                  AS mapping_fee,            -- NULL 이어야 자동적용 후보
  opm.price_adjustment     AS mapping_price_adjustment,
  opm.settle_discount_type AS mapping_settle_discount_type
FROM `order` o
JOIN order_product_mapping opm ON opm.order_id = o.id
WHERE o.id = 5570    -- ← 대상 주문 id 로 교체
ORDER BY opm.id;

-- ── 3-1. billing_user 에 등록된 할인 룰이 존재/매칭 가능한지 ──
--    0건이면 findMatchingDiscount 가 무조건 null → 자동적용 불가(할인 룰 미등록).
--    (3번의 billing_user_id 를 :billingUserId 에 넣어 실행)
SELECT
  ud.id, ud.category, ud.primary_category, ud.classification_id,
  ud.`group`, ud.method, ud.`range`, ud.compare_condition,
  ud.price_adjustment, ud.price_percent, ud.partner_company_id
FROM user_discount ud
WHERE ud.user_id = 22    -- ← 3번의 billing_user_id 로 교체
ORDER BY ud.category, ud.id;

-- ── 4. [교정 템플릿 / 실행 전 반드시 2번으로 공유 여부 확인] ──
--    단독 정산코드이고 현금이 맞다면 wallet.settle_method 를 CASH 로 교정.
--    공유 코드라면 이 UPDATE 는 다른 계정까지 바꾸므로 절대 실행 금지 (별도 코드 분리 필요).
-- UPDATE wallet_account
--   SET settle_method = 'CASH'
--   WHERE owner_type = 'SETTLEMENT_CODE'
--     AND owner_id = 'company-1';   -- 1번에서 확인한 단독 settlement_code 만
