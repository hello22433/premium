-- ============================================================================
-- 20260701_settlement_code_provisioning_backfill.sql
-- PR-A (foundation, DARK) — settlement_code 배정 + 공유 wallet_account 프로비저닝 백필
-- ----------------------------------------------------------------------------
-- 목적:
--   (A) 빈 code(settlement_code='') 활성 유저를, 회사의 DISTINCT non-empty code 가 정확히 1개일 때만
--       그 코드에 합류(SHARE_ONE)시킨다. code 가 0개(전원 미배정)이거나 2개 이상이면 PENDING 으로 두고
--       운영자가 배정한다 (classifyJoin 과 동일 규칙, R10). 기존 회사에 base code 를 신규 강제 배정하지
--       않는다 (base code 는 NEW 회사 가입 경로 전용).
--   (B) 단일 base-code 회사의 base wallet_account 를 멱등 프로비저닝. 신규 생성 시 legacy 값
--       (company.balance+Σuser.balance, Σall_settle_amount)을 같은 TX 에서 시딩 → drift 0 을 구조적으로 보장.
--       credit_limit 재동기도 단일 base-code 회사에만 적용 (다중 code 회사의 code별 한도 보존).
--   (C) READ-ONLY zero-drift 리포트: deposit / credit_used / credit_excess / points 전 구성요소 (S2).
--
-- 실행 정책:
--   - 멱등 (여러 번 재실행 가능). INSERT IGNORE(uq_wallet_owner) / 조건부 UPDATE 로 중복 안전 (ON DUPLICATE/VALUES()·대상테이블 서브쿼리 미사용 → MySQL 버전 무관).
--   - staging 에서 먼저 (C) 리포트가 clean(0 drift) 인지 확인 → prod 적용 → prod 에서 (C) 재확인.
--   - 본 스크립트는 실행하지 않는다 (leader/운영자가 게이트 검증 후 수동 적용).
--   - 실행 권장: mysql --abort-source-on-error < 20260701_settlement_code_provisioning_backfill.sql
--
-- 전제:
--   - 20260521_backfill.sql (전체 company-{id} 강제 공유 백필) 이후의 정정/증분 대응.
--   - '활성 유저' = deleted_at IS NULL AND status <> 'LEAVE'.
-- ============================================================================

BEGIN;

-- ── (A) 빈 code 활성 유저 → 회사의 단일 기존 code 합류 (SHARE_ONE 전용) ──
-- 회사의 DISTINCT non-empty settlement_code 가 정확히 1개인 경우에만 그 코드로 합류시킨다.
-- 0개(전원 미배정) 또는 2개 이상이면 운영자 배정 대기(PENDING)로 남긴다 (classifyJoin R10 규칙 일치).
-- code 개수 판정은 classifyJoin 과 동일하게 회사 전체 유저 기준(삭제/탈퇴 포함), 갱신 대상은 활성 유저만.
UPDATE `user` u
  JOIN (
    SELECT u2.company_id AS cid,
           MIN(u2.settlement_code) AS the_code
      FROM `user` u2
     WHERE u2.company_id IS NOT NULL
       AND u2.settlement_code IS NOT NULL
       AND u2.settlement_code <> ''
     GROUP BY u2.company_id
    HAVING COUNT(DISTINCT u2.settlement_code) = 1
  ) single_code ON single_code.cid = u.company_id
   SET u.settlement_code = single_code.the_code
 WHERE u.settlement_code = ''
   AND u.deleted_at IS NULL
   AND u.status <> 'LEAVE';

-- ── (B) 단일 base-code 회사 base wallet_account 프로비저닝 (legacy 시딩 → drift 0) ──
-- 대상: DISTINCT non-empty code 가 1개이고 그 코드가 base('company-{id}') 인 회사만.
--       (다중 code 회사는 code별 wallet/한도를 운영자가 관리 → 백필이 건드리지 않는다.)
-- (B1) 없으면 생성: deposit/credit_used 를 legacy 에서 같은 TX 로 시딩 → (C) 리포트 drift 0 보장
--      (누락 wallet 을 0원으로 만든 뒤 커밋하는 문제 제거).
--      멱등: uq_wallet_owner + INSERT IGNORE 로 기존 wallet 은 skip(잔액 보존). 대상 테이블을
--      서브쿼리로 참조하지 않는다 → ER_UPDATE_TABLE_USED(1093) 회피, MySQL 버전 무관.
INSERT IGNORE INTO `wallet_account` (
  `owner_type`, `owner_id`,
  `deposit_balance`, `credit_limit`,
  `credit_used_amount`, `credit_excess_amount`,
  `settle_condition`, `settle_method`
)
SELECT
  'SETTLEMENT_CODE',
  CONCAT('company-', c.id),
  IFNULL(c.balance, 0) + IFNULL((SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = c.id), 0),
  IFNULL(c.maximum_limit, 0),
  IFNULL((SELECT SUM(u.all_settle_amount) FROM `user` u WHERE u.settlement_code = CONCAT('company-', c.id)), 0),
  0,
  COALESCE(
    (SELECT u.settle_condition FROM `user` u
      WHERE u.company_id = c.id AND u.settlement_code = CONCAT('company-', c.id)
        AND u.deleted_at IS NULL AND u.status <> 'LEAVE'
      ORDER BY u.id LIMIT 1),
    'POST_PAYMENT'),
  COALESCE(c.settle_method, 'CASH')
  FROM `user_company` c
 WHERE (
         SELECT COUNT(DISTINCT u.settlement_code)
           FROM `user` u
          WHERE u.company_id = c.id
            AND u.settlement_code IS NOT NULL
            AND u.settlement_code <> ''
       ) = 1
   AND EXISTS (
         SELECT 1 FROM `user` u
          WHERE u.company_id = c.id
            AND u.settlement_code = CONCAT('company-', c.id)
       );

-- (B2) 기존 base wallet 의 credit_limit 만 회사 한도로 재동기 — 단일 base-code 회사에만 (다중 code 한도 보존).
--      잔액 컬럼(deposit/credit_used/credit_excess)은 발송확정 흐름 소유 → 미변경.
UPDATE `wallet_account` w
  JOIN `user_company` c ON w.owner_id = CONCAT('company-', c.id)
   SET w.credit_limit = IFNULL(c.maximum_limit, 0)
 WHERE w.owner_type = 'SETTLEMENT_CODE'
   AND w.credit_limit <> IFNULL(c.maximum_limit, 0)
   AND (
         SELECT COUNT(DISTINCT u.settlement_code)
           FROM `user` u
          WHERE u.company_id = c.id
            AND u.settlement_code IS NOT NULL
            AND u.settlement_code <> ''
       ) = 1
   AND EXISTS (
         SELECT 1 FROM `user` u
          WHERE u.company_id = c.id
            AND u.settlement_code = CONCAT('company-', c.id)
       );

-- 각 code 당 단일 wallet row 확인 후 COMMIT (아래 (C)-0 리포트가 0 row 여야 함).
COMMIT;

-- ============================================================================
-- (C) READ-ONLY zero-drift 리포트 (전 fund 구성요소) — 실행 후 결과 검토용
--     각 리포트가 "0 rows" 이면 clean. 1 row 이상이면 운영자 확인/보정 필요.
--     wallet 은 settlement_code(owner_id) 단위 pool. base code(company-{id}) 만
--     legacy(user.balance/company.balance/all_settle_amount) 와 1:1 대응 가능.
-- ============================================================================

-- ── (C)-0. code 중복 wallet (uq_wallet_owner 위반 잔재) ──
SELECT owner_type, owner_id, COUNT(*) AS dup_cnt
  FROM `wallet_account`
 GROUP BY owner_type, owner_id
HAVING COUNT(*) > 1;

-- ── (C)-1. deposit_balance drift: wallet vs legacy(company.balance + Σuser.balance) ──
-- base code 만 대상 (company-{id}). legacy_deposit != wallet_deposit 인 회사만 반환.
SELECT
  c.id AS company_id,
  CONCAT('company-', c.id) AS settlement_code,
  IFNULL(c.balance, 0) + IFNULL((SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = c.id), 0) AS legacy_deposit,
  w.deposit_balance AS wallet_deposit
  FROM `user_company` c
  JOIN `wallet_account` w
    ON w.owner_type = 'SETTLEMENT_CODE'
   AND w.owner_id = CONCAT('company-', c.id)
 WHERE IFNULL(c.balance, 0) + IFNULL((SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = c.id), 0)
       <> w.deposit_balance
 ORDER BY c.id;

-- ── (C)-2. credit_used drift: wallet.credit_used_amount vs Σ(code 소속 유저).all_settle_amount ──
-- 모든 code 대상 (owner_id 기준으로 유저 그룹핑). drift != 0 인 code 만 반환.
SELECT
  w.owner_id AS settlement_code,
  IFNULL((SELECT SUM(u.all_settle_amount) FROM `user` u WHERE u.settlement_code = w.owner_id), 0) AS legacy_all_settle,
  w.credit_used_amount AS wallet_credit_used
  FROM `wallet_account` w
 WHERE w.owner_type = 'SETTLEMENT_CODE'
   AND IFNULL((SELECT SUM(u.all_settle_amount) FROM `user` u WHERE u.settlement_code = w.owner_id), 0)
       <> w.credit_used_amount
 ORDER BY w.owner_id;

-- ── (C)-3. credit_excess: legacy 미존재 → PR-A 시점엔 발송확정 누적분 그대로 (참고 리포트) ──
-- 음수이거나 credit_limit 초과 등 이상치만 반환.
SELECT
  w.owner_id AS settlement_code,
  w.credit_limit,
  w.credit_used_amount,
  w.credit_excess_amount
  FROM `wallet_account` w
 WHERE w.owner_type = 'SETTLEMENT_CODE'
   AND (w.credit_excess_amount < 0 OR w.credit_used_amount < 0 OR w.deposit_balance < 0)
 ORDER BY w.owner_id;

-- ── (C)-4. points 이상치 리포트 (음수 잔여만) — flag-ON 0-drift gate 제외 대상 ──
-- points 는 legacy 대응 소스가 없어 drift 개념이 없다 (wallet-only 인벤토리). 정상 양수 잔여는 이상치가 아니므로
-- 반환/게이팅하지 않는다. 음수 잔여(이상치)만 반환. (정상 잔여 포인트 인벤토리는 별도 운영 조회로 확인.)
SELECT
  w.owner_id AS settlement_code,
  IFNULL(SUM(pg.remaining_amount), 0) AS remaining_points,
  MIN(pg.remaining_amount) AS min_remaining
  FROM `wallet_account` w
  LEFT JOIN `point_grant` pg
    ON pg.wallet_account_id = w.id
   AND pg.active = 1
   AND (pg.expires_at IS NULL OR pg.expires_at > NOW())
 WHERE w.owner_type = 'SETTLEMENT_CODE'
 GROUP BY w.owner_id
HAVING MIN(pg.remaining_amount) < 0
 ORDER BY w.owner_id;

-- ── (C)-5. PENDING 리포트: 배정 대기 유저 (빈 code 활성 유저) + 사유 ──
-- 운영자 후속 배정 대상. distinct non-empty code 수로 사유 분류.
SELECT
  c.id AS company_id,
  COUNT(DISTINCT NULLIF(u.settlement_code, '')) AS distinct_nonempty_codes,
  SUM(CASE WHEN u.settlement_code = '' AND u.deleted_at IS NULL AND u.status <> 'LEAVE' THEN 1 ELSE 0 END) AS empty_active_users,
  GROUP_CONCAT(DISTINCT NULLIF(u.settlement_code, '') ORDER BY u.settlement_code) AS codes
  FROM `user_company` c
  JOIN `user` u ON u.company_id = c.id
 GROUP BY c.id
HAVING empty_active_users > 0
 ORDER BY c.id;
-- distinct_nonempty_codes >= 2 → 운영자가 각 유저에 assign; = 0/1(non-base) 케이스는 상단 (A) 로직과 대조 확인.
