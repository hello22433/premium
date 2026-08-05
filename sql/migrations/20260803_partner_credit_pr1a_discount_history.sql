-- 협력사 여신관리/정산확정 PR1A — 정산조건 이력 스키마
-- 정본: plans/2026-07-09-partner-credit-management-spec.md §5.5 · §5.15.2 · §5.10 · §8.6 · §8.7
-- PR 명세: plans/2026-08-03-partner-credit-PR1A-spec.md
--
-- 이 마이그레이션은 additive 전용이다. 쓰기 API를 열지 않으며, 원장(partner_settle_ledger)은 PR1B 소유다.

-- ---------------------------------------------------------------------------
-- 1. partner_discount_scope — scopeKey / policyTargetKey 잠금 앵커
--    history row가 0개인 신규 scope도 앵커로 최초 동시 쓰기를 직렬화한다.
--    scope_key 는 접두어로 네임스페이스가 갈린다: 'sk1|' = scopeKey, 'pt1|' = policyTargetKey
-- ---------------------------------------------------------------------------
CREATE TABLE `partner_discount_scope` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `scope_key`  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
      COMMENT 'canonical scopeKey(sk1|...) 또는 policyTargetKey(pt1|...)',
  `created_at` DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_partner_discount_scope_key` (`scope_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 정산조건 scope 잠금 앵커 (값 필드 없음·불변)';

-- ---------------------------------------------------------------------------
-- 2. partner_discount_policy_epoch — 협력사별 정책 epoch (reader/writer 직렬화)
--    reader(원장 생성) = FOR SHARE, writer(CRUD/예약/소급) = FOR UPDATE + epoch++
-- ---------------------------------------------------------------------------
CREATE TABLE `partner_discount_policy_epoch` (
  `partner_company_id` INT         NOT NULL,
  `epoch`              BIGINT      NOT NULL DEFAULT 0,
  `created_at`         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`partner_company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 정산조건 정책 epoch (S/X 락 직렬화 지점)';

-- ---------------------------------------------------------------------------
-- 3. partner_discount_history — 정산조건 이력 (값 불변 + 구간 종료 메타 갱신)
--    userId 는 복제하지 않는다: 대상 = user_discount 의 partner scope row 뿐.
-- ---------------------------------------------------------------------------
CREATE TABLE `partner_discount_history` (
  `id`                       INT          NOT NULL AUTO_INCREMENT,
  `partner_company_id`       INT          NOT NULL COMMENT 'FK) partner_company.id',
  `category`                 VARCHAR(24)  NOT NULL COMMENT 'PRODUCT_GROUP|CATEGORY|BRAND',
  `classification_id`        INT          NULL     COMMENT 'FK) classification.id',
  `method`                   VARCHAR(16)  NOT NULL COMMENT 'SECTION|BULK',
  `primary_category`         VARCHAR(100) NULL     COMMENT '브랜드',
  `group`                    VARCHAR(100) NULL     COMMENT '상품군',
  `range`                    VARCHAR(100) NULL     COMMENT '구간',
  `compare_condition`        VARCHAR(16)  NOT NULL COMMENT 'ALL|MORE_THAN|LESS_THAN|OVER|LESS',
  `scope_key`                VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
      COMMENT 'canonical scopeKey (sk1|...)',
  `change_type`              VARCHAR(16)  NOT NULL COMMENT 'CREATE|UPDATE|DELETE(tombstone)',
  `price_percent`            INT          NULL     COMMENT 'DELETE tombstone 에서만 NULL',
  `price_adjustment`         VARCHAR(16)  NULL     COMMENT 'DISCOUNT|ADDITIONAL. DELETE tombstone 에서만 NULL',
  `valid_from`               DATETIME(6)  NOT NULL,
  `valid_to`                 DATETIME(6)  NULL     COMMENT 'NULL = open 구간',
  `changed_by`               INT          NULL     COMMENT 'FK) user.id',
  `superseded_by_history_id` INT          NULL     COMMENT '경계 일치 소급으로 대체된 경우 대체 row',
  `open_key`                 VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
      GENERATED ALWAYS AS (
        CASE WHEN `valid_to` IS NULL AND `superseded_by_history_id` IS NULL AND `deleted_at` IS NULL
             THEN `scope_key` END
      ) STORED,
  `created_at`               DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`               DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`               DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  -- scope 당 활성 open 구간 정확히 1개를 DB 가 강제한다.
  UNIQUE KEY `uk_partner_discount_history_open` (`open_key`),
  KEY `idx_partner_discount_history_scope` (`scope_key`, `valid_from`),
  KEY `idx_partner_discount_history_partner` (`partner_company_id`),
  CONSTRAINT `chk_partner_discount_history_value`
    CHECK (
      (`change_type` = 'DELETE' AND `price_percent` IS NULL AND `price_adjustment` IS NULL)
      OR (`change_type` <> 'DELETE' AND `price_percent` IS NOT NULL AND `price_adjustment` IS NOT NULL)
    ),
  CONSTRAINT `chk_partner_discount_history_interval`
    CHECK (`valid_to` IS NULL OR `valid_from` < `valid_to`),
  -- 할인율 절대 상한. 실무 상한(env)은 DTO·서비스에서 별도 강제한다.
  CONSTRAINT `chk_partner_discount_history_percent`
    CHECK (
      `price_adjustment` IS NULL
      OR (`price_adjustment` = 'DISCOUNT'   AND `price_percent` BETWEEN 0 AND 100)
      OR (`price_adjustment` = 'ADDITIONAL' AND `price_percent` BETWEEN 0 AND 1000)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 정산조건 이력 (append-only · 구간 모델)';

-- ---------------------------------------------------------------------------
-- 4. order_product_mapping — findMatchingDiscount 입력 스냅샷 보강
--    주문 라인 생성/수정 시점에 기존 snapshot_* 과 동일 row·동일 시점으로 기록한다.
--    레거시 row 는 live product 조인으로 채우지 않는다(과거 정산 변동 금지).
-- ---------------------------------------------------------------------------
ALTER TABLE `order_product_mapping`
  ADD COLUMN `snapshot_product_category` VARCHAR(100) NULL
      COMMENT '[snapshot] 주문 시점 상품군(product.category)' AFTER `snapshot_product_brand_name`,
  ADD COLUMN `snapshot_product_classification_id` INT NULL
      COMMENT '[snapshot] 주문 시점 카테고리(product.classificationId)' AFTER `snapshot_product_category`;

-- ---------------------------------------------------------------------------
-- 5. user_discount — user scope XOR partner scope 불변식
--    선행조건: 아래 위반 조회가 0건이어야 한다. 위반 잔존 시 이 ALTER 는 실패한다(의도된 fail-closed).
--
--    SELECT id, user_id, partner_company_id FROM user_discount
--     WHERE (user_id IS NULL AND partner_company_id IS NULL)
--        OR (user_id IS NOT NULL AND partner_company_id IS NOT NULL);
-- ---------------------------------------------------------------------------
ALTER TABLE `user_discount`
  ADD CONSTRAINT `chk_user_discount_scope_xor`
    CHECK ((`user_id` IS NULL) <> (`partner_company_id` IS NULL));
