-- 협력사 여신관리/정산확정 PR3B — 정산조건 예약
-- 정본: .agents/plans/EP/EP_P10_partner_credit_spec.md §5.6 · §8.3 · §8.6 · §9 · §11
-- PR 명세: .agents/plans/EP/EP_P10_partner_credit_pr3b_spec.md
-- 적용 순서: PR3A(20260807_partner_settle_pr3a_variance.sql) 뒤.
--
-- additive 전용이다. 기존 테이블을 바꾸지 않으며, 발효 cron 은 feature flag off 로 배포한다.

-- ---------------------------------------------------------------------------
-- partner_discount_reservation — 정산조건 예약
--   status 는 정본 3종에 BLOCKED 를 더한 4종이다. 정책 충돌로 발효가 거부된 예약을 PENDING 으로
--   남기면 cron 이 매 주기마다 같은 충돌을 재시도해 로그·알림이 폭주하므로, 종료 상태로 뺀다.
--   해제는 취소 후 재예약이며 active_key 가 NULL 이라 같은 (scope_key, effective_at) 재예약을 막지 않는다.
-- ---------------------------------------------------------------------------
CREATE TABLE `partner_discount_reservation` (
  `id`                   INT          NOT NULL AUTO_INCREMENT,
  `partner_company_id`   INT          NOT NULL COMMENT 'FK) partner_company.id',
  `category`             VARCHAR(24)  NOT NULL COMMENT 'PRODUCT_GROUP|CATEGORY|BRAND',
  `classification_id`    INT          NULL     COMMENT 'FK) classification.id',
  `method`               VARCHAR(16)  NOT NULL COMMENT 'SECTION|BULK',
  `primary_category`     VARCHAR(100) NULL     COMMENT '브랜드',
  `group`                VARCHAR(100) NULL     COMMENT '상품군',
  `range`                VARCHAR(100) NULL     COMMENT '구간',
  `compare_condition`    VARCHAR(16)  NOT NULL COMMENT 'ALL|MORE_THAN|LESS_THAN|OVER|LESS',
  `scope_key`            VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
      COMMENT 'canonical scopeKey (sk1|...)',
  `price_percent`        INT          NOT NULL COMMENT '예약된 수수료 (percent)',
  `price_adjustment`     VARCHAR(16)  NOT NULL COMMENT 'DISCOUNT|ADDITIONAL',
  `effective_at`         DATETIME(6)  NOT NULL COMMENT '적용 시각. history 의 valid_from 이 되는 값',
  `status`               VARCHAR(16)  NOT NULL COMMENT 'PENDING|APPLIED|CANCELED|BLOCKED',
  `registered_by`        INT          NOT NULL COMMENT 'FK) user.id',
  `result_history_id`    INT          NULL     COMMENT 'FK) partner_discount_history.id — 발효로 생긴 새 값 구간',
  `request_key`          VARCHAR(100) NOT NULL COMMENT '생성 멱등 키',
  `payload_hash`         VARCHAR(100) NOT NULL COMMENT '생성 요청 정규화 hash',
  `payload_hash_version` VARCHAR(8)   NOT NULL DEFAULT 'v1',
  `is_retroactive`       TINYINT(1)   NOT NULL
      COMMENT '생성 시점 기준 소급 여부(effective_at < created_at). cron 이 지연된 미래 예약과 구분하는 근거',
  `last_failure_code`    VARCHAR(32)  NULL     COMMENT 'POLICY_CONFLICT|INTERVAL_INVARIANT|RETROACTIVE_DISABLED',
  `last_failure_at`      DATETIME(6)  NULL,
  `active_key`           TINYINT(1)   GENERATED ALWAYS AS (CASE WHEN `status` = 'PENDING' THEN 1 END) STORED,
  `created_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`           DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  -- 같은 scope·같은 시각의 PENDING 은 1건. 동시 생성 2건 중 1건만 성공한다(앱 레벨 체크 아님).
  UNIQUE KEY `uk_partner_discount_reservation_active` (`scope_key`, `effective_at`, `active_key`),
  UNIQUE KEY `uk_partner_discount_reservation_request` (`request_key`),
  KEY `idx_partner_discount_reservation_due` (`status`, `effective_at`),
  KEY `idx_partner_discount_reservation_partner` (`partner_company_id`),
  CONSTRAINT `fk_partner_discount_reservation_history`
    FOREIGN KEY (`result_history_id`) REFERENCES `partner_discount_history` (`id`),
  -- 상태값은 4종뿐이다. 오타·수동 UPDATE 로 미지의 값이 들어가면 active_key 가 NULL 이라 중복 예약이
  -- 열리고, due 조회(status='PENDING')에서도 영구히 빠져 예약이 조용히 사라진다.
  CONSTRAINT `chk_partner_discount_reservation_status`
    CHECK (`status` IN ('PENDING', 'APPLIED', 'CANCELED', 'BLOCKED')),
  -- 실패 사유도 알려진 코드로 제한한다.
  CONSTRAINT `chk_partner_discount_reservation_failure_code`
    CHECK (
      `last_failure_code` IS NULL
      OR `last_failure_code` IN ('POLICY_CONFLICT', 'INTERVAL_INVARIANT', 'RETROACTIVE_DISABLED')
    ),
  -- history 와 같은 절대 상한. 실무 상한(env)은 DTO·서비스에서 별도 강제한다.
  CONSTRAINT `chk_partner_discount_reservation_percent`
    CHECK (
      (`price_adjustment` = 'DISCOUNT'   AND `price_percent` BETWEEN 0 AND 100)
      OR (`price_adjustment` = 'ADDITIONAL' AND `price_percent` BETWEEN 0 AND 1000)
    ),
  -- 발효 결과는 APPLIED 에만 있다. 그 외 상태에 result_history_id 가 있으면 이력 추적이 어긋난다.
  CONSTRAINT `chk_partner_discount_reservation_result`
    CHECK (
      (`status` = 'APPLIED' AND `result_history_id` IS NOT NULL)
      OR (`status` <> 'APPLIED' AND `result_history_id` IS NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 정산조건 예약 (PR3B)';

-- ---------------------------------------------------------------------------
-- 롤백
-- ---------------------------------------------------------------------------
-- DROP TABLE `partner_discount_reservation`;
