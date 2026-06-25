-- settle_method SoT 백필 (멱등)
-- 실행 시점: fix/settle-method-sot-sync 배포 후.
-- 목적: company.settle_method 가 NULL 인 기존 데이터를 user.settle_method 기준으로 백필.
-- 전제: user.settle_method 는 PR5 DROP 예정이나 현재 유효한 유일한 소스.
-- 주의: 하나의 company 에 여러 user 가 공유되는 경우 충돌 발생 가능 — 0단계에서 사전 확인 필수.

-- ── 0. 사전 확인: 같은 company 를 공유하는 user 들의 settle_method 가 다른 케이스 ──
-- 결과가 0 rows 이면 1단계로 진행. 아니면 해당 company_id 수동 처리 필요.
SELECT
  uc.id AS company_id,
  uc.business_name,
  COUNT(DISTINCT u.settle_method) AS distinct_methods,
  GROUP_CONCAT(DISTINCT u.settle_method ORDER BY u.settle_method) AS methods,
  GROUP_CONCAT(u.id ORDER BY u.id) AS user_ids
FROM user_company uc
JOIN user u ON u.company_id = uc.id
WHERE uc.settle_method IS NULL
  AND u.settle_method IS NOT NULL
  AND u.deleted_at IS NULL
GROUP BY uc.id, uc.business_name
HAVING distinct_methods > 1
ORDER BY uc.id;

-- ── 1. 백필: company 공유 user 의 settle_method 가 일치하는 경우만 적용 (충돌 없는 것만) ──
UPDATE user_company uc
JOIN (
  SELECT
    u.company_id,
    MIN(u.settle_method) AS method
  FROM user u
  WHERE u.company_id IS NOT NULL
    AND u.settle_method IS NOT NULL
    AND u.deleted_at IS NULL
  GROUP BY u.company_id
  HAVING COUNT(DISTINCT u.settle_method) = 1
) sub ON sub.company_id = uc.id
SET uc.settle_method = sub.method
WHERE uc.settle_method IS NULL;

-- ── 2. 검증: 백필 후 여전히 NULL 인 company (user.settle_method 자체가 NULL 인 경우) ──
-- 0 rows 이상이면 해당 계정은 관리자 수동 설정 필요.
SELECT
  uc.id AS company_id,
  uc.business_name,
  u.id AS user_id,
  u.email
FROM user_company uc
JOIN user u ON u.company_id = uc.id
WHERE uc.settle_method IS NULL
  AND u.deleted_at IS NULL
ORDER BY uc.id;
