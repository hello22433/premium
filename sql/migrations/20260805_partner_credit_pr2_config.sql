-- 협력사 여신관리 PR2 — 여신 설정(월 한도) · 변경 이력
-- 정본: plans/2026-07-09-partner-credit-management-spec.md §5.3 · §5.4 · §4.4
-- PR 명세: plans/2026-08-05-partner-credit-PR2-spec.md
--
-- additive 전용. 여신 API(credit/list·config)는 feature flag off 로 배포되며
-- flag on 은 정본 §15.2 배포 순서(마이그레이션 → config seed → SETTLE_CREDIT 권한 → flag on)의 소관이다.
-- 이 마이그레이션은 원장(partner_settle_ledger, PR1B)을 읽기만 하는 여신 표의 설정 테이블만 만든다.

-- ---------------------------------------------------------------------------
-- 1. partner_credit_config — 여신 설정 (협력사·하위항목 단위 · optimistic lock)
--    월 한도는 저장하지 않고 협력사 타입별 공식(보증보험/선입금/기타)으로 계산한다 (§4.4).
--    sub_item_key 는 NOT NULL sentinel 'NONE' 으로 통일한다 — MySQL unique index 는 NULL 중복을
--    허용하므로 하위 없는 협력사를 NULL 로 두면 UNIQUE 가 무력화된다 (§5.3).
-- ---------------------------------------------------------------------------
CREATE TABLE `partner_credit_config` (
  `id`                  INT          NOT NULL AUTO_INCREMENT,
  `partner_company_id`  INT          NOT NULL COMMENT 'FK) partner_company.id',
  `sub_item_key`        VARCHAR(32)  NOT NULL COMMENT '하위항목 키. 하위 없으면 sentinel NONE',
  `insurance_amount`    BIGINT       NOT NULL COMMENT '보증보험 (원 단위 정수)',
  `prepaid_amount`      BIGINT       NOT NULL COMMENT '선입금',
  `etc_amount`          BIGINT       NOT NULL COMMENT '기타',
  `version`             INT          NOT NULL DEFAULT 0 COMMENT 'optimistic lock. 갱신마다 +1 (3차 M3)',
  `created_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`          DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_partner_credit_config_scope` (`partner_company_id`, `sub_item_key`),
  -- 음수 한도는 음수 채무·발송가능잔액 오염을 만든다 (21차 H2).
  CONSTRAINT `chk_partner_credit_config_insurance_nonneg` CHECK (`insurance_amount` >= 0),
  CONSTRAINT `chk_partner_credit_config_prepaid_nonneg`   CHECK (`prepaid_amount` >= 0),
  CONSTRAINT `chk_partner_credit_config_etc_nonneg`       CHECK (`etc_amount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 여신 설정 (월 한도 파라미터 · 협력사·하위항목 단위)';

-- ---------------------------------------------------------------------------
-- 2. partner_credit_config_history — 여신 설정 변경 이력 (append-only)
--    CREATE(최초 INSERT) 는 이전 값이 없어 before_* NULL, after_* 는 CREATE·UPDATE 모두 기록해
--    이력만으로 최초 설정 금액을 재현할 수 있게 한다 (22차·23차).
-- ---------------------------------------------------------------------------
CREATE TABLE `partner_credit_config_history` (
  `id`                        INT          NOT NULL AUTO_INCREMENT,
  `partner_company_id`        INT          NOT NULL,
  `sub_item_key`              VARCHAR(32)  NOT NULL COMMENT '하위 없으면 sentinel NONE',
  `action`                    VARCHAR(16)  NOT NULL COMMENT 'CREATE|UPDATE',
  `before_insurance_amount`   BIGINT       NULL COMMENT '변경 이전 스냅샷. action=CREATE 는 NULL',
  `before_prepaid_amount`     BIGINT       NULL,
  `before_etc_amount`         BIGINT       NULL,
  `after_insurance_amount`    BIGINT       NOT NULL COMMENT '변경/생성 후 스냅샷',
  `after_prepaid_amount`      BIGINT       NOT NULL,
  `after_etc_amount`          BIGINT       NOT NULL,
  `changed_by`                INT          NOT NULL COMMENT 'FK) user.id — 수정자',
  `changed_at`                DATETIME(6)  NOT NULL COMMENT 'KST naive',
  `created_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  KEY `idx_partner_credit_config_history_scope` (`partner_company_id`, `sub_item_key`, `changed_at`),
  CONSTRAINT `chk_partner_credit_config_history_action` CHECK (`action` IN ('CREATE','UPDATE')),
  -- CREATE ⇔ before 스냅샷 없음. 세 컬럼이 함께 NULL/NOT NULL 이어야 한다.
  CONSTRAINT `chk_partner_credit_config_history_before`
    CHECK (
      (`action` = 'CREATE'
        AND `before_insurance_amount` IS NULL AND `before_prepaid_amount` IS NULL AND `before_etc_amount` IS NULL)
      OR
      (`action` = 'UPDATE'
        AND `before_insurance_amount` IS NOT NULL AND `before_prepaid_amount` IS NOT NULL AND `before_etc_amount` IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 여신 설정 변경 이력 (append-only · 감사)';
