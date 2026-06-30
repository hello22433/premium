-- wallet_account.credit_limit 재동기화 (멱등)
-- 실행 시점: 최대서비스한도 변경 시 wallet.credit_limit 동기화 fix 배포 후 1회.
-- 목적: fix 이전에 운영자가 '최대서비스한도 변경' 팝업으로 company.maximum_limit 만 바꾼 탓에
--       stale 상태로 남은 wallet_account.credit_limit 를 company.maximum_limit 기준으로 보정.
-- 키 관계: wallet_account(owner_type='SETTLEMENT_CODE', owner_id) = user.settlement_code,
--          user.company_id -> user_company.id.maximum_limit 이 한도 SoT 의 원천(legacy).

-- ── 0. 사전 확인: 같은 settlement_code 를 공유하는 user 들의 company.maximum_limit 가 다른 케이스 ──
-- 결과가 0 rows 이면 1단계로 진행. 아니면 해당 settlement_code 수동 확인 필요.
SELECT
  u.settlement_code,
  COUNT(DISTINCT uc.maximum_limit) AS distinct_limits,
  GROUP_CONCAT(DISTINCT uc.maximum_limit ORDER BY uc.maximum_limit) AS limits,
  GROUP_CONCAT(DISTINCT uc.id ORDER BY uc.id) AS company_ids
FROM user u
JOIN user_company uc ON uc.id = u.company_id
WHERE u.settlement_code IS NOT NULL
  AND u.settlement_code <> ''
  AND u.deleted_at IS NULL
GROUP BY u.settlement_code
HAVING distinct_limits > 1
ORDER BY u.settlement_code;

-- ── 1. drift 확인: wallet.credit_limit != company.maximum_limit 인 settlement_code ──
-- 보정 전 영향 범위 파악용 (UPDATE 대상 미리보기).
SELECT
  w.id AS wallet_account_id,
  w.owner_id AS settlement_code,
  w.credit_limit AS wallet_credit_limit,
  sub.maximum_limit AS company_maximum_limit
FROM wallet_account w
JOIN (
  SELECT
    u.settlement_code,
    MIN(uc.maximum_limit) AS maximum_limit
  FROM user u
  JOIN user_company uc ON uc.id = u.company_id
  WHERE u.settlement_code IS NOT NULL
    AND u.settlement_code <> ''
    AND u.deleted_at IS NULL
  GROUP BY u.settlement_code
  HAVING COUNT(DISTINCT uc.maximum_limit) = 1
) sub ON sub.settlement_code = w.owner_id
WHERE w.owner_type = 'SETTLEMENT_CODE'
  AND w.credit_limit <> sub.maximum_limit
ORDER BY w.owner_id;

-- ── 2. 보정: maximum_limit 가 일치하는 settlement_code 만 적용 (충돌 없는 것만) ──
UPDATE wallet_account w
JOIN (
  SELECT
    u.settlement_code,
    MIN(uc.maximum_limit) AS maximum_limit
  FROM user u
  JOIN user_company uc ON uc.id = u.company_id
  WHERE u.settlement_code IS NOT NULL
    AND u.settlement_code <> ''
    AND u.deleted_at IS NULL
  GROUP BY u.settlement_code
  HAVING COUNT(DISTINCT uc.maximum_limit) = 1
) sub ON sub.settlement_code = w.owner_id
SET w.credit_limit = sub.maximum_limit
WHERE w.owner_type = 'SETTLEMENT_CODE'
  AND w.credit_limit <> sub.maximum_limit;

-- ── 3. 검증: 보정 후 남은 drift (0 rows 여야 정상; >0 이면 0단계 충돌 케이스로 수동 처리 필요) ──
SELECT
  w.id AS wallet_account_id,
  w.owner_id AS settlement_code,
  w.credit_limit AS wallet_credit_limit
FROM wallet_account w
JOIN user u ON u.settlement_code = w.owner_id AND u.deleted_at IS NULL
JOIN user_company uc ON uc.id = u.company_id
WHERE w.owner_type = 'SETTLEMENT_CODE'
  AND w.credit_limit <> uc.maximum_limit
GROUP BY w.id, w.owner_id, w.credit_limit
ORDER BY w.owner_id;
