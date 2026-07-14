-- =============================================================================
-- PR3 (WALLET_PR3_SETTLE_MODE) 전환 최종 투명성 게이트 — wallet_remain == legacy_remain 전수 대조
-- 일자: 2026-07-07
-- 성격: READ-ONLY. flip 직전(=legacy/shadow 상태) 및 flip 직후 둘 다 실행.
-- 근거: dev PR3 cutover 리허설(2026-07-07)에서 확정. 기존 cutover_gate(P0~P3)는
--   mixed-mode(장기 PR2=wallet 누적 / COMPANY 모드 phantom user.balance / 정산리셋 vs 미해제 alloc)에서
--   credit/deposit naive 총액 체크가 오탐/누락을 낸다. 반면 "고객이 실제 보는 잔여한도"를 양쪽
--   공식으로 계산해 대조하면 전환 투명성을 단일 지표로 확정할 수 있다.
--
-- 판정: 0 rows = 전 계정 wallet_remain == legacy_remain = 투명 전환 GO.
--        1 rows 이상 = 해당 settlement_code 가 어긋남 → 그 계정 reconcile 후 재검(NO-GO).
--
-- 공식 (settle.service.ts:2115/2792/2850 그대로):
--   legacy_remain = maximumLimit + effectiveBalance - Σ all_settle_amount
--     effectiveBalance = (COMPANY 모드 ? company.balance : Σ user.balance)   -- COMPANY 는 user.balance phantom
--   wallet_remain = credit_limit + deposit_balance - credit_used_amount - credit_excess_amount
--
-- 사용 순서 (런북):
--   1) flip 직전(freeze 하): 본 게이트 0 rows 확인 → GO.
--      0 rows 아니면 어긋난 settlement_code 를 credit_used(→Σall_settle) / deposit(→effectiveBalance) /
--      settle_method 기준으로 reconcile 후 재실행.
--   2) WALLET_PR3_SETTLE_MODE=wallet flip + 재시작.
--   3) flip 직후: 본 게이트 재실행 → 여전히 0 rows 확인(회귀 없음). 이후 freeze 해제.
-- =============================================================================

SELECT v.settlement_code,
       v.wallet_remain,
       v.legacy_remain,
       v.wallet_remain - v.legacy_remain AS diff,
       v.mode,
       v.wallet_credit_limit, v.company_maximum_limit,
       v.wallet_deposit, v.legacy_effective_balance,
       v.wallet_credit_used, v.wallet_credit_excess, v.legacy_all_settle
  FROM (
    SELECT w.owner_id AS settlement_code,
           MAX(uc.balance_management_type) AS mode,
           w.credit_limit AS wallet_credit_limit,
           MAX(uc.maximum_limit) AS company_maximum_limit,
           w.deposit_balance AS wallet_deposit,
           (CASE WHEN MAX(uc.balance_management_type) = 'COMPANY'
                 THEN MAX(uc.balance) ELSE COALESCE(SUM(u.balance),0) END) AS legacy_effective_balance,
           w.credit_used_amount AS wallet_credit_used,
           w.credit_excess_amount AS wallet_credit_excess,
           COALESCE(SUM(u.all_settle_amount),0) AS legacy_all_settle,
           -- wallet remain (PR3=wallet 이 서빙)
           (w.credit_limit + w.deposit_balance - w.credit_used_amount - w.credit_excess_amount) AS wallet_remain,
           -- legacy remain (PR3=legacy/shadow 가 서빙)
           (MAX(uc.maximum_limit)
             + (CASE WHEN MAX(uc.balance_management_type) = 'COMPANY'
                     THEN MAX(uc.balance) ELSE COALESCE(SUM(u.balance),0) END)
             - COALESCE(SUM(u.all_settle_amount),0)) AS legacy_remain
      FROM wallet_account w
      JOIN `user` u ON u.settlement_code = w.owner_id AND u.deleted_at IS NULL
      JOIN user_company uc ON uc.id = u.company_id
     WHERE w.owner_type = 'SETTLEMENT_CODE'
     GROUP BY w.owner_id, w.credit_limit, w.deposit_balance, w.credit_used_amount, w.credit_excess_amount
  ) v
 WHERE v.wallet_remain <> v.legacy_remain
 ORDER BY ABS(v.wallet_remain - v.legacy_remain) DESC;

-- 판정:
--   0 rows           → GO (전 계정 투명).
--   diff > 0 (양수)  → flip 시 잔여한도 과대(고객이 실제보다 많이 봄). 보통 wallet.credit_used 가
--                       Σall_settle 보다 낮거나(백필 미반영 정산) deposit 이 effectiveBalance 보다 높음(phantom).
--   diff < 0 (음수)  → flip 시 잔여한도 과소(고객이 실제보다 적게 봄). 보통 wallet.credit_used 가
--                       Σall_settle 보다 높음(백필 과대 seed 미해제).
--   → 각 계정: credit_used→Σall_settle, deposit→effectiveBalance(COMPANY=company.balance),
--     settle_method→company SoT 로 reconcile(ops_20260630 패턴, ledger INSERT-먼저 → 검증 → UPDATE) 후 재검.
-- =============================================================================
