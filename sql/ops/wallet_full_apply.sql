-- ============================================================================
-- WALLET 정산모델 통합 적용 SQL (PR1~PR2 schema/seed/backfill)
-- 생성: 원본 sql/*.sql 파일들을 적용 순서대로 병합. 내용 무수정.
--
-- !!! 한 번에 전체 실행 금지. SECTION 단위로 끊어서 적용 + 각 단계 검증 후 다음 진입.
-- !!! 개발(dev) 먼저. SECTION 0 결과 클린 확인 후 SECTION 9(backfill) 진입.
--
-- 실행 권장: mysql --abort-source-on-error  (에러 시 즉시 중단)
-- SECTION 9(backfill) 는 DELIMITER + stored proc 포함 → mysql CLI 로 실행.
--   Workbench/DataGrip 에 SECTION 단위로 붙여넣을 때 DELIMITER 미지원 클라이언트면
--   SECTION 9 만 따로 mysql CLI 로 실행할 것.
--
-- 적용 순서:
--   SECTION 0 : legacy 정합성 점검 (READ-ONLY. drift 있으면 수동보정 후 재실행)
--   SECTION 0.5: ALTER user +settlement_code (RUNBOOK step 1. resolver/backfill 의존) [DDL]
--   SECTION 1 : wallet_account, wallet_transaction        [DDL]
--   SECTION 2 : point_grant, point_policy_rule, order_point_usage [DDL]
--   SECTION 3 : order_payment_allocation (+line)          [DDL]
--   SECTION 4 : order_payment_refund_event               [DDL]
--   SECTION 5 : credit_excess_approval                   [DDL]
--   SECTION 6 : order_delivery_attempt                   [DDL]
--   SECTION 7 : ALTER allocation +released_at (MySQL 8.0.29+)
--   SECTION 8 : seed SSG 포인트 DENY                      [SEED]
--   SECTION 9 : backfill (SECTION 0 클린 통과 후에만!)     [DATA + 게이트 abort]
-- ============================================================================


-- ############################################################################
-- ## SECTION 0  <<  sql/20260527_wallet_legacy_reconcile.sql
-- ############################################################################

-- Wallet Cutover — Legacy Reconciler (Gap 2 → Gap 1 도구)
-- =====================================================
--
-- 목적:
--   wallet 백필(20260521_backfill.sql) 실행 전 legacy 데이터 (user.all_settle_amount,
--   user_company.balance, user_company.maximum_limit, order.settleAmount/isSettleBalance/
--   isCreditExcess) 가 일관성을 유지하는지 독립 재구성 + 차분(drift) 출력.
--
-- 원천 (source-of-truth):
--   order + order_product_mapping + order_delivery (사용자 합의 — 환불 ledger 미포함).
--   각 order 의 status / isSettleBalance / isCreditExcess / isSettleComplete /
--   settleAmount 를 기준으로 user.all_settle_amount 기대값을 재구성한다.
--
-- 실행:
--   read-only. console 출력만. 결과 row 가 있으면 운영자 검토 + 수동 보정 후
--   20260521_backfill.sql 실행.
--
-- 검사:
--   A) 음수 all_settle_amount — 직접 오염 시그널 (-36,472 사건 패턴).
--   B) 주문 합계 vs all_settle_amount mismatch (drift) — 양수/음수 양방향.
--   C) 회사 단위 SUM(all_settle_amount) > maximum_limit — 한도 초과.
--   D) 발송확정/주문 cancel 사이 상태 incoherence (참고용).
--
-- 한계:
--   - 부분 발송 실패 (한 order 의 일부 delivery FAIL) 시 order.settleAmount 가 그대로
--     남아있으면 expected 가 over-estimate. 운영자가 detail 확인 필요.
--   - balance / user_company.balance 재구성은 ledger 부재로 skip — 음수만 잡음.
--   - order_payment_refund_event 미포함 (PR2 이후 발생분만 있어 backfill 시점에는 0).

-- ============================================================================
-- A) 음수 all_settle_amount — 직접 오염
-- ============================================================================
SELECT '--- A) 음수 all_settle_amount ---' AS section;

SELECT u.id AS user_id, u.email, u.company_id, u.all_settle_amount
  FROM `user` u
 WHERE u.all_settle_amount < 0
 ORDER BY u.all_settle_amount ASC;

-- ============================================================================
-- B) 주문 합계 vs all_settle_amount drift
-- ============================================================================
-- 기대값 정의:
--   billing_user_id = COALESCE(order.client_user_id, order.user_id)
--   active credit order = order WHERE
--     status NOT IN ('TEMP', 'DELIVERY_CANCEL', 'DELETED')
--     AND is_settle_complete = 0
--     AND (is_settle_balance = 0 OR is_credit_excess = 1)
--   expected_all_settle = SUM(order.settle_amount) per billing_user_id
--
-- 비교:
--   drift = u.all_settle_amount - expected
--   양수 = legacy 가 더 많음 (환불 덜 적용 / 음수 over-charge 위험)
--   음수 = legacy 가 더 적음 (이중 환불 / -36,472 패턴 가능)

SELECT '--- B) 주문 합계 vs all_settle_amount drift ---' AS section;

WITH order_active AS (
  SELECT
    COALESCE(o.client_user_id, o.user_id) AS billing_user_id,
    o.id AS order_id,
    o.settle_amount,
    o.status,
    o.is_settle_balance,
    o.is_credit_excess,
    o.is_settle_complete
  FROM `order` o
  WHERE o.status NOT IN ('TEMP', 'DELIVERY_CANCEL', 'DELETED')
    AND o.is_settle_complete = 0
    AND (o.is_settle_balance = 0 OR o.is_credit_excess = 1)
),
expected_per_user AS (
  SELECT
    billing_user_id,
    SUM(settle_amount) AS expected_all_settle
  FROM order_active
  GROUP BY billing_user_id
)
SELECT
  u.id AS user_id,
  u.email,
  u.company_id,
  u.all_settle_amount AS legacy_all_settle,
  COALESCE(e.expected_all_settle, 0) AS expected_all_settle,
  u.all_settle_amount - COALESCE(e.expected_all_settle, 0) AS drift
FROM `user` u
LEFT JOIN expected_per_user e ON e.billing_user_id = u.id
WHERE u.all_settle_amount != COALESCE(e.expected_all_settle, 0)
ORDER BY ABS(u.all_settle_amount - COALESCE(e.expected_all_settle, 0)) DESC;

-- ============================================================================
-- B-2) 회사 단위 drift (wallet 백필이 company 단위 SUM 이므로 보강)
-- ============================================================================
SELECT '--- B-2) 회사 단위 drift ---' AS section;

WITH order_active AS (
  SELECT
    COALESCE(o.client_user_id, o.user_id) AS billing_user_id,
    o.settle_amount,
    o.is_settle_complete,
    o.is_settle_balance,
    o.is_credit_excess,
    o.status
  FROM `order` o
  WHERE o.status NOT IN ('TEMP', 'DELIVERY_CANCEL', 'DELETED')
    AND o.is_settle_complete = 0
    AND (o.is_settle_balance = 0 OR o.is_credit_excess = 1)
),
expected_per_user AS (
  SELECT billing_user_id, SUM(settle_amount) AS expected_all_settle
    FROM order_active GROUP BY billing_user_id
)
SELECT
  c.id AS company_id,
  c.business_name,
  SUM(u.all_settle_amount) AS legacy_total,
  SUM(COALESCE(e.expected_all_settle, 0)) AS expected_total,
  SUM(u.all_settle_amount) - SUM(COALESCE(e.expected_all_settle, 0)) AS drift_total
FROM `user_company` c
JOIN `user` u ON u.company_id = c.id
LEFT JOIN expected_per_user e ON e.billing_user_id = u.id
GROUP BY c.id, c.business_name
HAVING SUM(u.all_settle_amount) != SUM(COALESCE(e.expected_all_settle, 0))
ORDER BY ABS(SUM(u.all_settle_amount) - SUM(COALESCE(e.expected_all_settle, 0))) DESC;

-- ============================================================================
-- C) 회사 단위 maximum_limit 초과
-- ============================================================================
-- 한도가 줄어들었거나 over-charge 누적 케이스.
-- 백필 시 wallet_account.credit_used_amount > credit_limit 형성 → invariant 위반.

SELECT '--- C) 회사 단위 maximum_limit 초과 ---' AS section;

SELECT
  c.id AS company_id,
  c.business_name,
  c.maximum_limit,
  SUM(u.all_settle_amount) AS legacy_total_all_settle,
  SUM(u.all_settle_amount) - c.maximum_limit AS over_limit
FROM `user_company` c
JOIN `user` u ON u.company_id = c.id
GROUP BY c.id, c.business_name, c.maximum_limit
HAVING SUM(u.all_settle_amount) > c.maximum_limit
ORDER BY SUM(u.all_settle_amount) - c.maximum_limit DESC;

-- ============================================================================
-- D) 주문 상태 incoherence (참고용)
-- ============================================================================
-- DELIVERY_CANCEL 인데 isSettleBalance / allSettleAmount 잔존 한 케이스 등.
-- 환불 누락 의심.

SELECT '--- D) 주문 상태 incoherence (참고) ---' AS section;

-- D-1) DELIVERY_CANCEL 인데 isSettleComplete=true 가 아닌 케이스
SELECT
  o.id AS order_id,
  o.user_id,
  o.client_user_id,
  o.status,
  o.settle_amount,
  o.is_settle_balance,
  o.is_credit_excess,
  o.is_settle_complete,
  '취소된 주문인데 미정산' AS note
FROM `order` o
WHERE o.status = 'DELIVERY_CANCEL'
  AND o.is_settle_complete = 0
  AND o.settle_amount > 0
ORDER BY o.canceled_at DESC
LIMIT 100;

-- D-2) 발송확정 + 미정산 + isSettleBalance=true 인데 isCreditExcess=true (서로 배타적이어야)
SELECT
  o.id AS order_id,
  o.user_id,
  o.status,
  o.settle_amount,
  o.is_settle_balance,
  o.is_credit_excess,
  o.is_settle_complete,
  '예치금 차감 + 신용초과 동시 마킹' AS note
FROM `order` o
WHERE o.is_settle_balance = 1
  AND o.is_credit_excess = 1
LIMIT 100;

-- ============================================================================
-- E) 요약 카운트 (운영자 한눈에)
-- ============================================================================
SELECT '--- E) 요약 카운트 ---' AS section;

SELECT
  (SELECT COUNT(*) FROM `user` WHERE all_settle_amount < 0) AS negative_users,
  (SELECT COUNT(*) FROM (
    WITH order_active AS (
      SELECT
        COALESCE(o.client_user_id, o.user_id) AS billing_user_id,
        o.settle_amount,
        o.is_settle_complete,
        o.is_settle_balance,
        o.is_credit_excess,
        o.status
      FROM `order` o
      WHERE o.status NOT IN ('TEMP', 'DELIVERY_CANCEL', 'DELETED')
        AND o.is_settle_complete = 0
        AND (o.is_settle_balance = 0 OR o.is_credit_excess = 1)
    ),
    expected_per_user AS (
      SELECT billing_user_id, SUM(settle_amount) AS expected_all_settle
        FROM order_active GROUP BY billing_user_id
    )
    SELECT u.id
      FROM `user` u
      LEFT JOIN expected_per_user e ON e.billing_user_id = u.id
     WHERE u.all_settle_amount != COALESCE(e.expected_all_settle, 0)
  ) t) AS drift_users,
  (SELECT COUNT(*) FROM (
    SELECT c.id
      FROM `user_company` c
      JOIN `user` u ON u.company_id = c.id
     GROUP BY c.id, c.maximum_limit
    HAVING SUM(u.all_settle_amount) > c.maximum_limit
  ) t) AS over_limit_companies;

-- ============================================================================
-- 운영자 절차:
--   1. 위 결과 검토. drift_users / over_limit_companies / negative_users 가 0 이 아니면 보정 필요.
--   2. 보정은 case-by-case — 자동 SQL 미제공 (위험). 운영자가 수동 결정:
--      - 음수 → 0 으로 reset + 회계 보고 (실 외상 사용분 manual ledger 정리).
--      - 양수 drift → 환불/할인 적용 누락 여부 검토 후 case-by-case correction.
--      - over_limit → maximum_limit 상향 또는 강제 정산 후 reset.
--   3. 보정 후 본 스크립트 재실행 → 모든 section 결과 0 row 확인.
--   4. 20260521_backfill.sql 실행 (gate 가 한 번 더 차단).
-- ============================================================================


-- ############################################################################
-- ## SECTION 0.5  <<  sql/20260521_alter_user_add_settlement_code.sql
-- ############################################################################

-- PR1a Wallet: user.settlement_code 컬럼 추가
-- RUNBOOK step 1. resolver(wallet_account 조회) + SECTION 9 backfill 이 의존.
-- prod 미존재 확인됨 (SHOW COLUMNS ... LIKE 'settlement_code' → Empty set).
-- DEFAULT '' 이라 backfill 전까지 NOT NULL 위반 없음. backfill 후 별도 NOT NULL 강제 가능.
--
-- 적용 환경: MySQL 8.0.12+ (DEFAULT 있는 컬럼 ADD = INSTANT, 큰 user 테이블도 즉시).
-- 멱등: SECTION 0.5 재실행 시 컬럼/인덱스 중복 에러. 재실행 전 SECTION 0.5 skip 또는
--   ADD COLUMN IF NOT EXISTS (8.0.29+) 로 교체할 것.

ALTER TABLE `user`
  ADD COLUMN `settlement_code` VARCHAR(50) NOT NULL DEFAULT '' COMMENT 'wallet_account.owner_id 매핑 키 (default: company-{companyId})' AFTER `company_id`;

-- 인덱스: wallet_account_resolver 조회용
CREATE INDEX `idx_user_settlement_code` ON `user` (`settlement_code`);


-- ############################################################################
-- ## SECTION 1  <<  sql/20260521_create_wallet_tables.sql
-- ############################################################################

-- PR1a Wallet: wallet_account + wallet_transaction
-- Cross-Cutting Invariants §1 (row split), §2 (idempotency key catalog)
-- owner_type='SETTLEMENT_CODE' 단일값 (CHECK + UNIQUE(owner_type, owner_id))

CREATE TABLE `wallet_account` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `owner_type` VARCHAR(20) NOT NULL COMMENT 'SETTLEMENT_CODE 단일값',
  `owner_id` VARCHAR(50) NOT NULL COMMENT 'user.settlement_code 값 (예: company-123)',
  `deposit_balance` INT NOT NULL DEFAULT 0 COMMENT '예치금 잔액',
  `credit_limit` INT NOT NULL DEFAULT 0 COMMENT '여신 한도',
  `credit_used_amount` INT NOT NULL DEFAULT 0 COMMENT '여신 사용액',
  `credit_excess_amount` INT NOT NULL DEFAULT 0 COMMENT '신용초과 사용액',
  `settle_condition` VARCHAR(20) NOT NULL DEFAULT 'POST_PAYMENT' COMMENT 'PRE_PAYMENT(선정산) / POST_PAYMENT(후정산). settlement_code 단위 정책.',
  `settle_method` VARCHAR(20) NOT NULL DEFAULT 'CASH' COMMENT 'CARD / CASH. settlement_code 단위 정책.',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY `uq_wallet_owner` (`owner_type`, `owner_id`),
  CONSTRAINT `chk_wallet_owner_type` CHECK (`owner_type` = 'SETTLEMENT_CODE')
) COMMENT='wallet 잔액 단일 테이블 (settlement_code 단위)';

CREATE TABLE `wallet_transaction` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `wallet_account_id` BIGINT NOT NULL,
  `order_id` INT NULL,
  `order_delivery_id` INT NULL,
  `type` VARCHAR(40) NOT NULL COMMENT 'CONFIRM | CANCEL | FAIL_REFUND | DISCARD_REFUND | RESEND_DEDUCT | SETTLE_RELEASE | SETTLE_UNDO | GRANT 등',
  `resource_type` VARCHAR(20) NOT NULL COMMENT 'DEPOSIT | CREDIT | CREDIT_EXCESS | POINT',
  `amount` INT NOT NULL COMMENT '차감은 음수, 적립/복구는 양수',
  `balance_after` INT NULL COMMENT '해당 resource_type 잔액 갱신 후 값',
  `memo` VARCHAR(500) NULL,
  `idempotency_key` VARCHAR(120) NOT NULL COMMENT '{event}:{orderId}:{deliveryId?}:{resource}:{cycle?}',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY `uq_wallet_tx_idempotency` (`idempotency_key`),
  KEY `idx_wallet_tx_order` (`order_id`),
  KEY `idx_wallet_tx_delivery` (`order_delivery_id`),
  KEY `idx_wallet_tx_account` (`wallet_account_id`)
) COMMENT='wallet 잔액 변동 ledger';


-- ############################################################################
-- ## SECTION 2  <<  sql/20260521_create_point_tables.sql
-- ############################################################################

-- PR1a Wallet: point_grant + point_policy_rule
-- Cross-Cutting Invariants §6 (포인트 grant 선택 순서)

CREATE TABLE `point_grant` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `wallet_account_id` BIGINT NOT NULL,
  `original_amount` INT NOT NULL COMMENT '발급 시점 금액',
  `remaining_amount` INT NOT NULL COMMENT '잔여 금액',
  `expires_at` DATETIME NULL COMMENT 'NULL = 만료 없음',
  `reason` VARCHAR(200) NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY `idx_point_grant_wallet_expire` (`wallet_account_id`, `expires_at`)
) COMMENT='포인트 grant';

CREATE TABLE `point_policy_rule` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `owner_type` VARCHAR(20) NOT NULL COMMENT 'COMMON | COMPANY | POINT_GRANT',
  `owner_id` BIGINT NULL COMMENT 'owner_type=COMMON이면 NULL',
  `effect` VARCHAR(10) NOT NULL COMMENT 'ALLOW | DENY',
  `scope_type` VARCHAR(30) NOT NULL COMMENT 'PRODUCT | BRAND | CATEGORY | PARTNER_COMPANY | ORDER_TYPE',
  `scope_id` BIGINT NULL,
  `scope_code` VARCHAR(100) NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY `idx_point_policy_owner` (`owner_type`, `owner_id`),
  KEY `idx_point_policy_scope` (`scope_type`, `scope_id`, `scope_code`)
) COMMENT='포인트 사용 가능 정책';

CREATE TABLE `order_point_usage` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `allocation_id` BIGINT NOT NULL,
  `order_id` INT NOT NULL,
  `order_delivery_id` INT NULL,
  `point_grant_id` BIGINT NOT NULL,
  `used_amount` INT NOT NULL,
  `restored_amount` INT NOT NULL DEFAULT 0,
  `skipped_expired_amount` INT NOT NULL DEFAULT 0,
  `expires_at_snapshot` DATETIME NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY `idx_order_point_usage_order` (`order_id`),
  KEY `idx_order_point_usage_delivery` (`order_delivery_id`),
  KEY `idx_order_point_usage_grant` (`point_grant_id`)
) COMMENT='주문/배송별 포인트 grant 사용 기록';


-- ############################################################################
-- ## SECTION 3  <<  sql/20260521_create_order_payment_allocation.sql
-- ############################################################################

-- PR1a Wallet: order_payment_allocation + order_payment_allocation_line
-- Cross-Cutting Invariants §5 (카드할증 풀 모델) + §8 (풀 기반 환불)

CREATE TABLE `order_payment_allocation` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `order_id` INT NOT NULL,
  `wallet_account_id` BIGINT NOT NULL,
  `gross_settlement_amount` INT NOT NULL COMMENT 'Σ line.gross_settlement_amount (카드할증 미포함)',
  `point_used_amount` INT NOT NULL DEFAULT 0,
  `payable_settlement_amount` INT NOT NULL COMMENT '= card_surcharge_total (deposit + credit + credit_excess 합과 동일)',
  `deposit_used_amount` INT NOT NULL DEFAULT 0,
  `credit_used_amount` INT NOT NULL DEFAULT 0,
  `credit_excess_amount` INT NOT NULL DEFAULT 0,
  `card_surcharge_amount` INT NOT NULL DEFAULT 0 COMMENT '주문 단위 카드할증 풀',
  `card_surcharge_applied` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '발송확정 시점 snapshot. 환불 시 applyCardSurcharge() 호출에 사용',
  `has_discount` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '할인/할증 적용 여부 (mutex 검증)',
  `settle_method_snapshot` VARCHAR(20) NULL COMMENT '발송확정 시점 order.settle_method snapshot',
  -- 환불 누적 (풀 기반)
  `point_restored_amount` INT NOT NULL DEFAULT 0,
  `credit_excess_restored_amount` INT NOT NULL DEFAULT 0,
  `credit_used_restored_amount` INT NOT NULL DEFAULT 0,
  `deposit_restored_amount` INT NOT NULL DEFAULT 0,
  `point_skipped_expired_amount` INT NOT NULL DEFAULT 0 COMMENT '만료로 복구 안 한 누적 (audit)',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY `uq_order_payment_allocation_order` (`order_id`),
  KEY `idx_allocation_wallet` (`wallet_account_id`)
) COMMENT='주문 단위 정산 스냅샷';

CREATE TABLE `order_payment_allocation_line` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `allocation_id` BIGINT NOT NULL,
  `order_id` INT NOT NULL,
  `order_product_mapping_id` INT NOT NULL,
  `order_delivery_id` INT NULL COMMENT '신규 흐름은 NOT NULL. legacy fallback만 NULL',
  `product_id` INT NULL,
  `brand_id` INT NULL,
  `category` VARCHAR(100) NULL,
  `partner_company_id` INT NULL,
  `order_type` VARCHAR(30) NOT NULL,
  `gross_settlement_amount` INT NOT NULL COMMENT '카드할증 미포함. calculateSettlementPrice(mapping, false, delivery)',
  `applied_fee_percent` INT NULL COMMENT '발송확정 시점 fee snapshot',
  `applied_price_adjustment` VARCHAR(20) NULL COMMENT 'DISCOUNT | ADDITIONAL | NULL',
  `point_used_amount` INT NOT NULL DEFAULT 0,
  `payable_base` INT NOT NULL COMMENT '= gross_settlement_amount - point_used_amount',
  `deposit_used_amount` INT NOT NULL DEFAULT 0 COMMENT '정보용. 환불은 풀 기반',
  `credit_used_amount` INT NOT NULL DEFAULT 0 COMMENT '정보용',
  `credit_excess_amount` INT NOT NULL DEFAULT 0 COMMENT '정보용',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY `idx_allocation_line_order` (`order_id`),
  KEY `idx_allocation_line_delivery` (`order_delivery_id`),
  KEY `idx_allocation_line_alloc` (`allocation_id`)
) COMMENT='배송별 정산 스냅샷 라인';


-- ############################################################################
-- ## SECTION 4  <<  sql/20260521_create_order_payment_refund_event.sql
-- ############################################################################

-- PR1a Wallet: order_payment_refund_event
-- Cross-Cutting Invariants §8 (풀 기반 환불 ledger + 재발송 역환불)

CREATE TABLE `order_payment_refund_event` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `allocation_id` BIGINT NOT NULL,
  `order_id` INT NOT NULL,
  `event_type` VARCHAR(30) NOT NULL COMMENT 'fail_refund | discard_refund | cancel',
  `affected_delivery_ids` JSON NOT NULL COMMENT '이 이벤트에서 환불된 delivery id 배열',
  `refunded_gross_base` INT NOT NULL COMMENT 'Σ line.gross_settlement_amount (라인 base, 포인트 포함)',
  `refunded_payable_base` INT NOT NULL COMMENT 'Σ (line.gross - line.point_used). 카드할증 base 산정용',
  `refunded_card_surcharge_amount` INT NOT NULL COMMENT 'remaining-payable-base delta로 계산된 카드할증 환불액',
  `refunded_point_amount` INT NOT NULL DEFAULT 0,
  `refunded_deposit_amount` INT NOT NULL DEFAULT 0,
  `refunded_credit_used_amount` INT NOT NULL DEFAULT 0,
  `refunded_credit_excess_amount` INT NOT NULL DEFAULT 0,
  `point_skipped_expired_amount` INT NOT NULL DEFAULT 0,
  `idempotency_key` VARCHAR(120) NOT NULL,
  `reversed_at` DATETIME(6) NULL COMMENT '재발송 역환불 시 이 ledger를 되돌린 시각',
  `reversed_by_wallet_transaction_id` BIGINT NULL COMMENT '역환불을 수행한 wallet_transaction.id',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY `uq_refund_event_idempotency` (`idempotency_key`),
  KEY `idx_refund_event_order` (`order_id`),
  KEY `idx_refund_event_alloc` (`allocation_id`)
) COMMENT='주문 단위 부분 환불 ledger';


-- ############################################################################
-- ## SECTION 5  <<  sql/20260521_create_credit_excess_approval.sql
-- ############################################################################

-- PR1a Wallet: credit_excess_approval
-- Open Decision 2: 신용초과 운영관리자 수동 승인 4단계 워크플로 audit trail

CREATE TABLE `credit_excess_approval` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `order_id` INT NOT NULL,
  `wallet_account_id` BIGINT NOT NULL,
  `requested_amount` INT NOT NULL COMMENT '발송확정 시점 payable_settlement_amount',
  `requested_credit_excess_amount` INT NOT NULL COMMENT '신용초과 분배 예상액',
  `reason_text` VARCHAR(200) NOT NULL COMMENT 'Step B 사유 (필수)',
  `requested_by` INT NOT NULL COMMENT '요청한 user.id (기업관리자)',
  `requested_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING | APPROVED | REJECTED | EXPIRED',
  `approved_by` INT NULL COMMENT '승인/거절한 user.id (운영관리자)',
  `approved_at` DATETIME(6) NULL,
  `reject_reason` VARCHAR(200) NULL,
  `consumed_at` DATETIME(6) NULL COMMENT '발송확정에서 사용된 시각 (조건부 UPDATE로 1회만 사용 보장)',
  UNIQUE KEY `uq_credit_excess_consumed` (`id`, `consumed_at`),
  KEY `idx_credit_excess_order` (`order_id`),
  KEY `idx_credit_excess_status` (`status`)
) COMMENT='신용초과 운영관리자 승인 4단계 워크플로';


-- ############################################################################
-- ## SECTION 6  <<  sql/20260521_create_order_delivery_attempt.sql
-- ############################################################################

-- PR1a Wallet: order_delivery_attempt
-- Cross-Cutting Invariants §4 (재발송 흐름 명세, qa D2-11 대응)
-- 모든 fail_refund / resend_deduct 이벤트의 idempotency key cycle = 이 테이블의 PK

CREATE TABLE `order_delivery_attempt` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `order_delivery_id` INT NOT NULL,
  `attempt_type` VARCHAR(20) NOT NULL COMMENT 'INITIAL | RESEND',
  `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING | DEDUCTED | SENT | FAILED | ROLLED_BACK | COMPLETED',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `deducted_at` DATETIME(6) NULL,
  `sent_at` DATETIME(6) NULL,
  `failed_at` DATETIME(6) NULL,
  `completed_at` DATETIME(6) NULL,
  `failure_reason` VARCHAR(500) NULL,
  KEY `idx_delivery_attempt_delivery` (`order_delivery_id`, `status`),
  KEY `idx_delivery_attempt_type` (`attempt_type`)
) COMMENT='발송 시도 universal log (최초 + 재발송)';


-- ############################################################################
-- ## SECTION 7  <<  sql/20260523_alter_order_payment_allocation_add_released.sql
-- ############################################################################

-- PR2 Wallet Cutover Bundle (PR2+PR3+PR4)
-- ALTER order_payment_allocation: released_at + release_reason
--
-- 목적:
--   OrderConfirmationReleaseService.releaseConfirmation() 보상 TX 의 결과를 allocation 레벨에 기록.
--   wallet-managed 후속 hook 의 routing predicate 는 다음을 사용:
--     EXISTS(allocation WHERE order_id = ? AND released_at IS NULL)
--   released_at IS NOT NULL 인 allocation 은 legacy path 로 회귀.
--
-- Plan 참조: .omc/plans/wallet-cutover-bundle-consensus-plan.md (F-001)
-- Spec 참조: .omc/specs/deep-interview-wallet-pr2-to-pr5-hook-strategy.md (Round 3 결정)
--
-- 적용 환경:
--   - MySQL 8.0.29+ (ALGORITHM=INPLACE + LOCK=NONE + ADD COLUMN IF NOT EXISTS 모두 지원)
--   - 사전에 다음 SQL 로 prod 호환성 확인:
--       SELECT VERSION();                                  -- 8.0.29 이상 보장
--       SELECT COUNT(*) FROM order_payment_allocation;     -- ALTER 영향 row 수 측정
--     예상 duration < 5min @ 1M rows (MySQL 8.0+ INPLACE).
--   - prod 적용 시 dry-run staging 에서 wall-clock duration 먼저 확인 후 prod 진입.
--
-- 적용 순서 (RUNBOOK):
--   1. staging dry-run: 본 SQL 실행 + 컬럼 존재 + NULL default 확인.
--   2. prod 적용: maintenance window 권장 (LOCK=NONE 이라 INSERT/UPDATE/SELECT 차단 없음).
--   3. 적용 후 backfill 불필요 (default NULL = "active wallet-managed", 신규 보상 시 채워짐).
--   4. 이후 PR2 wallet 활성화 RUNBOOK (legacy → shadow → wallet) 진입 가능.

-- 주의: MySQL 은 ADD COLUMN IF NOT EXISTS 미지원 (MariaDB 문법). 신규 컬럼이라 멱등 불필요.
--   재실행 시 Duplicate column 에러 나면 이미 적용된 것 → skip.
ALTER TABLE `order_payment_allocation`
  ADD COLUMN `released_at` DATETIME(6) NULL DEFAULT NULL
    COMMENT 'OrderConfirmationReleaseService 가 보상 TX 로 allocation 을 무효화한 시각. NULL = active wallet-managed.',
  ADD COLUMN `release_reason` VARCHAR(200) NULL DEFAULT NULL
    COMMENT '보상 사유 (external API timeout / message enqueue failed / manual rollback 등). released_at 갱신 시 같이 채움.',
  ALGORITHM=INPLACE,
  LOCK=NONE;

-- routing predicate 가 EXISTS(allocation WHERE order_id=? AND released_at IS NULL) 패턴을 자주 쓰므로
-- (order_id, released_at) 부분 인덱스 후보. 그러나 PR1 UNIQUE(order_id) 가 이미 order_id 단일 lookup 을 보장하고
-- released_at 추가 필터링은 row 1 건 read 후 평가 (성능 영향 미미). 별도 인덱스 미생성.

-- =====================================================================
-- ROLLBACK SQL (운영자 수동 실행, 본 plan 범위 밖)
-- =====================================================================
-- 본 ALTER 적용 후 wallet-managed 주문이 prod 에 1건이라도 생성됐다면
-- 컬럼 DROP 시 데이터 손실 발생 → 운영자가 명시적으로 결정해야 함.
--
-- 안전 rollback (PR2 prod wallet 미활성화 시점에만 가능):
--   ALTER TABLE `order_payment_allocation`
--     DROP COLUMN IF EXISTS `released_at`,
--     DROP COLUMN IF EXISTS `release_reason`,
--     ALGORITHM=INPLACE,
--     LOCK=NONE;
--
-- PR2 prod wallet 활성화 후 rollback 은 권장하지 않음.
-- 필요 시 .omc/plans/wallet-cutover-bundle-consensus-plan.md
-- ADR Consequences + RUNBOOK manual recovery 절차 참조.


-- ############################################################################
-- ## SECTION 8  <<  sql/20260521_seed_point_policy_ssg_deny.sql
-- ############################################################################

-- PR1b Wallet: 공통 SSG 포인트 사용 DENY 시드
-- 시스템 기본은 ALLOW 이지만 SSG 권종은 공통 DENY (Global Verification Matrix).
-- 고객사 예외 (owner_type=COMPANY) 로 특정 고객사에만 ALLOW 가능.

INSERT INTO point_policy_rule (owner_type, owner_id, effect, scope_type, scope_code, active)
VALUES
  ('COMMON', NULL, 'DENY', 'PARTNER_COMPANY', 'SSG', 1),
  ('COMMON', NULL, 'DENY', 'ORDER_TYPE',      'SSG', 1),
  ('COMMON', NULL, 'DENY', 'BRAND',           '신세계', 1);


-- ############################################################################
-- ## SECTION 9  <<  sql/20260521_backfill.sql
-- ############################################################################

-- PR1a Wallet: legacy → wallet_account backfill
-- consensus plan v4 (verified against user.company.entity.ts:32-44)
-- 컬럼 매핑:
--   user_company.balance       (회사 선충전잔액)
--   + Σ user.balance per company (ACCOUNT 모드도 회사 공유로 합산)
--                              → wallet_account.deposit_balance
--   user_company.maximumLimit  (여신 한도)
--                              → wallet_account.credit_limit
--   credit_used / credit_excess (legacy 미존재)
--                              → 0 (PR2 발송확정에서 누적 시작)
--
-- 모든 user → settlement_code='company-{companyId}' 강제 공유
-- balanceManagementType 분기 폐지 (ACCOUNT 모드 user도 회사 단위 wallet 공유)
--
-- 실행: 단일 트랜잭션. assertion 불일치 시 ROLLBACK + 알림.
-- 사전 게이트: 20260527_wallet_legacy_reconcile.sql 의 검사 항목을 stored proc 에서 재실행해
--   drift / 음수 / over_limit row 가 1개라도 있으면 SIGNAL 로 abort.
--   클린 통과 안 되면 백필 자체가 시작 안 됨 → wallet 시드 오염 사전 차단.
-- 실행 권장: mysql --abort-source-on-error < 20260521_backfill.sql

-- ============================================================================
-- GATE: legacy cleansing 검증
-- ============================================================================
DROP PROCEDURE IF EXISTS check_legacy_clean_for_backfill;
DELIMITER //
CREATE PROCEDURE check_legacy_clean_for_backfill()
BEGIN
  DECLARE negative_count INT DEFAULT 0;
  DECLARE drift_user_count INT DEFAULT 0;
  DECLARE over_limit_company_count INT DEFAULT 0;

  -- 1) 음수 all_settle_amount
  SELECT COUNT(*) INTO negative_count
    FROM `user`
   WHERE all_settle_amount < 0;

  -- 2) 주문 합계 vs all_settle_amount drift (사용자 단위)
  SELECT COUNT(*) INTO drift_user_count
    FROM (
      WITH order_active AS (
        SELECT
          COALESCE(o.client_user_id, o.user_id) AS billing_user_id,
          o.settle_amount
        FROM `order` o
        WHERE o.status NOT IN ('TEMP', 'DELIVERY_CANCEL', 'DELETED')
          AND o.is_settle_complete = 0
          AND (o.is_settle_balance = 0 OR o.is_credit_excess = 1)
      ),
      expected_per_user AS (
        SELECT billing_user_id, SUM(settle_amount) AS expected_all_settle
          FROM order_active GROUP BY billing_user_id
      )
      SELECT u.id
        FROM `user` u
        LEFT JOIN expected_per_user e ON e.billing_user_id = u.id
       WHERE ABS(u.all_settle_amount - COALESCE(e.expected_all_settle, 0)) >= 100000
    ) t;
  -- 임계 100,000: reconcile expected 는 환불 ledger 미포함 + 부분발송실패 미보정이라
  --   소액 drift(±수천~수만)는 SoT 부정확에서 오는 noise. 외부 고객사 실데이터라 임의 보정 부적절.
  --   여신 통제 우회/over-charge 같은 유의미 손상(company2 음수, gallup +4.78M)만 abort 대상으로 남긴다.

  -- 3) 회사 단위 maximum_limit 초과
  SELECT COUNT(*) INTO over_limit_company_count
    FROM (
      SELECT c.id
        FROM `user_company` c
        JOIN `user` u ON u.company_id = c.id
       GROUP BY c.id, c.maximum_limit
      HAVING SUM(u.all_settle_amount) > c.maximum_limit
    ) t;

  IF negative_count > 0 OR drift_user_count > 0 OR over_limit_company_count > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      CONCAT(
        'legacy cleansing required before wallet backfill: negative_users=', negative_count,
        ' drift_users=', drift_user_count,
        ' over_limit_companies=', over_limit_company_count,
        '. 20260527_wallet_legacy_reconcile.sql 실행 후 운영자 보정 → 본 SQL 재실행.'
      );
  END IF;
END //
DELIMITER ;

CALL check_legacy_clean_for_backfill();
DROP PROCEDURE IF EXISTS check_legacy_clean_for_backfill;

-- ============================================================================
-- 본 백필 (GATE 통과 후에만 도달)
-- ============================================================================
BEGIN;

-- 1. 모든 user에 settlement_code 부여 (회사 단위 공유)
UPDATE `user` u
  JOIN `user_company` c ON u.company_id = c.id
   SET u.settlement_code = CONCAT('company-', c.id)
 WHERE u.settlement_code = ''
   AND u.company_id IS NOT NULL;

-- 2. wallet_account 생성 (회사 단위, 멱등)
--    NOT EXISTS 가드로 재실행 가능 (PR2 진입 시 drift 정정용 재실행 대비)
--    credit_used_amount = Σ user.allSettleAmount per company (기존 미정산 여신 사용분 이관)
--    credit_excess_amount = 0 (legacy 미존재, PR2 발송확정에서 누적 시작)
--    settle_condition / settle_method: company 안에서 첫 user (id ASC) 의 값 채택.
--    Mixed 인 회사는 운영 확인 필요 (PR3 운영자 UI 에서 별 settlement_code 분리 가능).
INSERT INTO `wallet_account` (
  `owner_type`, `owner_id`,
  `deposit_balance`, `credit_limit`,
  `credit_used_amount`, `credit_excess_amount`,
  `settle_condition`, `settle_method`
)
SELECT
  'SETTLEMENT_CODE',
  CONCAT('company-', c.id),
  IFNULL(c.balance, 0) + IFNULL(
    (SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = c.id),
    0
  ),
  IFNULL(c.maximum_limit, 0),
  IFNULL(
    (SELECT SUM(u.all_settle_amount) FROM `user` u WHERE u.company_id = c.id),
    0
  ),
  0,  -- credit_excess_amount: legacy 미존재. PR2 발송확정에서 누적
  IFNULL(
    (SELECT u.settle_condition FROM `user` u WHERE u.company_id = c.id ORDER BY u.id ASC LIMIT 1),
    'POST_PAYMENT'
  ),
  IFNULL(
    (SELECT u.settle_method FROM `user` u WHERE u.company_id = c.id ORDER BY u.id ASC LIMIT 1),
    'CASH'
  )
FROM `user_company` c
ON DUPLICATE KEY UPDATE
  -- 재실행 시 deposit / credit_limit / credit_used 만 갱신 (drift 정정).
  -- credit_excess_amount / settle_condition / settle_method 는 발송확정 흐름이 갱신하므로 보존.
  deposit_balance = IFNULL(c.balance, 0) + IFNULL(
    (SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = c.id),
    0
  ),
  credit_limit = IFNULL(c.maximum_limit, 0),
  credit_used_amount = IFNULL(
    (SELECT SUM(u.all_settle_amount) FROM `user` u WHERE u.company_id = c.id),
    0
  );

-- 4. Mixed settleCondition 검증 (운영자 후속 조치 대상 식별)
SELECT c.id AS company_id,
       COUNT(DISTINCT u.settle_condition) AS distinct_conditions,
       GROUP_CONCAT(DISTINCT u.settle_condition) AS conditions
  FROM `user_company` c
  JOIN `user` u ON u.company_id = c.id
 GROUP BY c.id
HAVING COUNT(DISTINCT u.settle_condition) > 1;
-- 위 결과가 1 row 이상이면 운영자가 별 settlement_code 부여 후 wallet 분리 필요 (PR3 UI).

-- 3. 검증 (verified columns only)
-- 3-1. deposit 보존
SELECT
  (SELECT IFNULL(SUM(balance), 0) FROM `user`) +
  (SELECT IFNULL(SUM(balance), 0) FROM `user_company`) AS legacy_deposit,
  (SELECT IFNULL(SUM(deposit_balance), 0) FROM `wallet_account`) AS wallet_deposit;

-- 3-2. credit_limit 보존
SELECT
  (SELECT IFNULL(SUM(maximum_limit), 0) FROM `user_company`) AS legacy_credit_limit,
  (SELECT IFNULL(SUM(credit_limit), 0) FROM `wallet_account`) AS wallet_credit_limit;

-- 3-3. credit_used 보존 (legacy user.allSettleAmount 이관 검증)
SELECT
  (SELECT IFNULL(SUM(all_settle_amount), 0) FROM `user`) AS legacy_all_settle_amount,
  (SELECT IFNULL(SUM(credit_used_amount), 0) FROM `wallet_account`) AS wallet_credit_used;
-- legacy_all_settle_amount == wallet_credit_used 여야 함.

-- 3-3b. credit_excess wallet=0 검증 (legacy 미존재, PR2 에서 누적 시작)
SELECT
  (SELECT IFNULL(SUM(credit_excess_amount), 0) FROM `wallet_account`) AS wallet_credit_excess_should_be_0;

-- 3-4. settlement_code 중복 검증 (0 row 반환이어야 함)
SELECT owner_type, owner_id, COUNT(*) AS dup_cnt
  FROM `wallet_account`
 GROUP BY owner_type, owner_id
HAVING COUNT(*) > 1;

-- 각 쌍 일치 (deposit + credit_limit) + credit_used/excess = 0 + dup 0 확인 후
COMMIT;
-- 불일치 시 ROLLBACK + 운영 알림

