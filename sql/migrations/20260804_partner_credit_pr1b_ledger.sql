-- 협력사 여신관리/정산확정 PR1B — 정산 원장 · 전이 관측 · provider event inbox
-- 정본: plans/2026-07-09-partner-credit-management-spec.md §5.1 · §5.12 · §5.15.8 · §5.10 P7 · §6 · §15.2
-- PR 명세: plans/2026-08-04-partner-credit-PR1B-spec.md
--
-- additive 전용. 이 마이그레이션은 쓰기 API 를 열지 않으며 producer 는 feature flag off 로 배포된다.
--
-- 후속 PR 소유 테이블(batch·resolution·proposal)을 가리키는 FK 컬럼은 여기서 nullable 컬럼으로만 만들고,
-- FK 제약과 그 컬럼에 의존하는 CHECK 는 소유 PR(PR1C/PR1D/PR3)이 ALTER 로 추가한다 (PR 명세 §2.1 D1).

-- ---------------------------------------------------------------------------
-- 1. partner_provider_event_inbox — provider 원천 관측/orphan 적재 (append-only)
--    lane 2종:
--      관측 lane (origin POLL|PUSH|MANUAL) : PENDING → LINKED, observation 생성 근거
--      orphan lane (origin ORPHAN)        : 자동 원장 불가 event. observation 미생성
--    ledger·proposal 의 복합 FK 대상이 되므로 보조 UNIQUE 를 함께 만든다.
-- ---------------------------------------------------------------------------
CREATE TABLE `partner_provider_event_inbox` (
  `id`                         INT          NOT NULL AUTO_INCREMENT
      COMMENT '영속 ingestion identity — snapshot-only provider 의 unresolvedEvidenceKey = INBOX:{id}',
  `provider`                   VARCHAR(24)  NOT NULL COMMENT 'IPartnerCompanyType',
  `order_delivery_id`          INT          NOT NULL COMMENT 'FK) order_delivery.id',
  `source_type`                VARCHAR(16)  NOT NULL COMMENT 'ISSUANCE|EXCHANGE|USAGE',
  `origin`                     VARCHAR(16)  NOT NULL COMMENT 'POLL|PUSH|MANUAL|ORPHAN',
  `normalized_payload`         JSON         NOT NULL COMMENT '원천 payload 정규화 보존 (증적·불변)',
  `payload_fingerprint`        VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
      COMMENT '관측 lane append/dedup 판정용 정규화 hash (evidenceKey 아님)',
  `observed_status`            VARCHAR(64)  NOT NULL COMMENT '관측 상태 (cpnStatus·CancelPossibility 등)',
  `observed_at`                DATETIME(6)  NOT NULL COMMENT '우리 관측 시각 (occurredAt 아님)',
  `prev_inbox_row_id`          INT          NULL     COMMENT '같은 (delivery, provider) 직전 row — 상태 체인',
  `manual_proposal_id`         INT          NULL
      COMMENT 'origin=MANUAL 발급 근거 proposal id. FK·CHECK 는 PR1C 소유',
  `manual_ledger_proposal_id`  INT          NULL
      COMMENT 'orphan lane 수동 승인 proposal id. FK·수동 승인 CHECK 는 PR1C 소유',
  `ingress_fingerprint`        VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL
      COMMENT 'origin=ORPHAN 만 NOT NULL. 비시각 정규화 hash — 동일 malformed 재수신 1 row 수렴',
  `observation_id`             INT          NULL     COMMENT '이 row 가 만든 transition observation id',
  `processed_status`           VARCHAR(24)  NOT NULL
      COMMENT '관측 lane PENDING|LINKED / orphan lane ORPHAN_PENDING|ORPHAN_LEDGERED|ORPHAN_AUTO_LEDGERED|ORPHAN_DISCARDED',
  `created_at`                 DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                 DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                 DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  -- orphan lane 재스캔 멱등. 관측 lane 은 ingress_fingerprint NULL 이라 충돌하지 않는다.
  UNIQUE KEY `uk_partner_provider_event_inbox_ingress`
    (`provider`, `order_delivery_id`, `ingress_fingerprint`),
  -- 승인된 proposal 1건 = inbox row 1건
  UNIQUE KEY `uk_partner_provider_event_inbox_manual_proposal` (`manual_proposal_id`),
  UNIQUE KEY `uk_partner_provider_event_inbox_manual_ledger_proposal` (`manual_ledger_proposal_id`),
  -- 복합 FK 대상 키 (PR1C proposal · ledger orphan 정산이 참조)
  UNIQUE KEY `uk_partner_provider_event_inbox_id_manual_proposal` (`id`, `manual_proposal_id`),
  UNIQUE KEY `uk_partner_provider_event_inbox_id_manual_ledger_proposal` (`id`, `manual_ledger_proposal_id`),
  UNIQUE KEY `uk_partner_provider_event_inbox_id_delivery` (`id`, `order_delivery_id`),
  UNIQUE KEY `uk_partner_provider_event_inbox_id_scope`
    (`id`, `provider`, `order_delivery_id`, `source_type`),
  KEY `idx_partner_provider_event_inbox_lane` (`provider`, `order_delivery_id`, `origin`, `id`),
  KEY `idx_partner_provider_event_inbox_status` (`processed_status`, `id`),
  -- inbox 는 관측/orphan ingress 전용이다. 원장 전용 ADJUSTMENT·임의 값이 섞이면
  -- producer 가 그 row 를 정상 관측으로 오인해 원장 경로에 밀어넣는다.
  CONSTRAINT `chk_partner_provider_event_inbox_source_type`
    CHECK (`source_type` IN ('ISSUANCE','EXCHANGE','USAGE')),
  CONSTRAINT `chk_partner_provider_event_inbox_origin`
    CHECK (`origin` IN ('POLL','PUSH','MANUAL','ORPHAN')),
  -- lane 과 상태의 상호배타. orphan row 가 관측 lane 복구 규칙에 섞이는 것을 DB 가 막는다.
  CONSTRAINT `chk_partner_provider_event_inbox_lane_status`
    CHECK (
      (`origin` =  'ORPHAN' AND `processed_status` IN ('ORPHAN_PENDING','ORPHAN_LEDGERED','ORPHAN_AUTO_LEDGERED','ORPHAN_DISCARDED'))
      OR
      (`origin` <> 'ORPHAN' AND `processed_status` IN ('PENDING','LINKED'))
    ),
  CONSTRAINT `chk_partner_provider_event_inbox_ingress_fingerprint`
    CHECK ((`origin` = 'ORPHAN') = (`ingress_fingerprint` IS NOT NULL)),
  -- 자동 정산 claim 은 proposal 없이 producer 가 수행한다 (63차-H1).
  CONSTRAINT `chk_partner_provider_event_inbox_auto_ledgered`
    CHECK (`processed_status` <> 'ORPHAN_AUTO_LEDGERED' OR `manual_ledger_proposal_id` IS NULL),
  CONSTRAINT `chk_partner_provider_event_inbox_manual_ledger_origin`
    CHECK (`manual_ledger_proposal_id` IS NULL OR `origin` = 'ORPHAN')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 provider 원천 관측/orphan inbox (append-only · evidence 영구보존)';

-- ---------------------------------------------------------------------------
-- 2. partner_settle_transition_observation — 상태 전이 관측
--    정상 감지 = sourceEventId 확정(RESOLVED, 같은 트랜잭션에서 ledger append)
--    미복원    = unresolvedBaseKey + unresolvedEvidenceKey 보관(UNRESOLVED, ledger 없음)
--    활성 UNRESOLVED 1건 UNIQUE 는 두지 않는다 (15차 — E2 를 삼키므로 재도입 금지).
-- ---------------------------------------------------------------------------
CREATE TABLE `partner_settle_transition_observation` (
  `id`                          INT          NOT NULL AUTO_INCREMENT,
  `order_delivery_id`           INT          NOT NULL COMMENT 'FK) order_delivery.id',
  `source_type`                 VARCHAR(16)  NOT NULL COMMENT 'ISSUANCE|EXCHANGE|USAGE',
  `prev_status`                 VARCHAR(32)  NOT NULL,
  `new_status`                  VARCHAR(32)  NOT NULL,
  `provider`                    VARCHAR(24)  NOT NULL COMMENT 'IPartnerCompanyType',
  `source_event_id`             VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL
      COMMENT '정상 관측만 NOT NULL (증적으로 검증된 불변 ID)',
  `source_event_id_origin`      VARCHAR(16)  NULL COMMENT 'PROVIDER 또는 NULL. observation 에 MANUAL 없음',
  `source_occurred_at`          DATETIME(6)  NULL COMMENT '원천 발생 시각',
  `source_version`              VARCHAR(64)  NULL COMMENT '원천 monotonic version (대부분 없음·자동발번 금지)',
  `observed_at`                 DATETIME(6)  NOT NULL,
  `observation_key`             VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
      COMMENT '영구 identity. 정상=EXC:{provider}:{sourceType}:{sourceEventId} / 미복원=base+evidence',
  `unresolved_base_key`         VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL
      COMMENT 'UNRES:{provider}:{orderDeliveryId}:{sourceType}',
  `unresolved_evidence_key`     VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL
      COMMENT '재현 가능한 근거 (payload fingerprint / INBOX:{id})',
  `generation`                  INT          NULL COMMENT '감사용 발생 순번 표기 전용 (identity 미사용·자동증가 금지)',
  `resolution_status`           VARCHAR(16)  NOT NULL COMMENT 'RESOLVED|UNRESOLVED',
  `first_seen_run_id`           VARCHAR(64)  NULL,
  `last_seen_run_id`            VARCHAR(64)  NULL,
  `resolution_proposed_by`      INT          NULL COMMENT 'FK) user.id — PR1C',
  `resolution_approved_by`      INT          NULL COMMENT 'FK) user.id — PR1C',
  `resolved_at`                 DATETIME(6)  NULL,
  `resolution_bundle_hash`      VARCHAR(128) NULL COMMENT '해소 proposal 증적 bundle hash — PR1C',
  `created_at`                  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                  DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_partner_settle_observation_key` (`observation_key`),
  -- 재스캔 중복 차단. 해소(RESOLVED) 후 같은 과거 창을 새 runId 로 재실행해도 동일 evidence 면 같은 key.
  UNIQUE KEY `uk_partner_settle_observation_unresolved` (`unresolved_base_key`, `unresolved_evidence_key`),
  KEY `idx_partner_settle_observation_delivery` (`order_delivery_id`, `source_type`),
  KEY `idx_partner_settle_observation_resolution` (`resolution_status`),
  -- 정상 관측과 미복원 관측의 필드 조합을 DB 가 가른다 (16차·56차-H2).
  CONSTRAINT `chk_partner_settle_observation_origin`
    CHECK (
      (`source_event_id_origin` = 'PROVIDER'
        AND `source_event_id` IS NOT NULL
        AND `unresolved_base_key` IS NULL
        AND `unresolved_evidence_key` IS NULL
        AND `generation` IS NULL)
      OR
      (`source_event_id_origin` IS NULL
        AND `source_event_id` IS NULL
        AND `unresolved_base_key` IS NOT NULL
        AND `unresolved_evidence_key` IS NOT NULL
        AND `generation` IS NOT NULL)
    ),
  CONSTRAINT `chk_partner_settle_observation_resolution_status`
    CHECK (`resolution_status` IN ('RESOLVED','UNRESOLVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 정산 상태전이 관측 (사실 불변 · UNRESOLVED→RESOLVED 1회 CAS)';

-- ---------------------------------------------------------------------------
-- 3. partner_settle_ledger — 정산 이벤트 원장 (SoT · append-only)
--    금액은 전부 BIGINT(원 단위 정수), 시각은 KST naive DATETIME(6).
--    취소/차감은 음수 row append 로만 표현하며 원본 조건 스냅샷을 반대 부호로 복제한다.
-- ---------------------------------------------------------------------------
CREATE TABLE `partner_settle_ledger` (
  `id`                             INT          NOT NULL AUTO_INCREMENT,
  `partner_company_id`             INT          NOT NULL COMMENT 'FK) partner_company.id',
  `sub_item_key`                   VARCHAR(32)  NOT NULL
      COMMENT '하위항목 키. GALAXIA 4종·CULTURE 2종·그 외 NONE. PAYMENT_VARIANCE sentinel 은 PR3',
  `source_type`                    VARCHAR(16)  NOT NULL COMMENT 'ISSUANCE|EXCHANGE|USAGE|ADJUSTMENT',
  `order_delivery_id`              INT          NULL COMMENT 'FK) order_delivery.id. 순수 수동 조정만 NULL',
  `galaxia_barcode_log_id`         INT          NULL COMMENT 'FK) galaxia_barcode_log.id. USAGE 만',
  `occurred_at`                    DATETIME(6)  NULL
      COMMENT '귀속 시점. TIME_UNRECOVERABLE 격리 동안만 NULL (임의 시각 생성 금지)',
  `base_amount`                    BIGINT       NULL
      COMMENT '발행/교환=정가, 사용=사용액. 취소는 음수. PRICE_UNRECOVERABLE·UNKNOWN 동안만 NULL',
  `discount_amount`                BIGINT       NOT NULL DEFAULT 0 COMMENT '정산 참고자료 할인금액 스냅샷',
  `receiving_commission_amount`    BIGINT       NOT NULL DEFAULT 0 COMMENT '받는수수료 (ADDITIONAL)',
  `giving_commission_amount`       BIGINT       NOT NULL DEFAULT 0 COMMENT '주는수수료 (DISCOUNT)',
  `vat_amount`                     BIGINT       NOT NULL DEFAULT 0 COMMENT 'VAT signed',
  `vat_calculation_mode`           VARCHAR(24)  NOT NULL DEFAULT 'NONE'
      COMMENT 'SEPARATE_ROUND|INCLUDED_REMAINDER|NONE',
  `fee_total_amount`               BIGINT       NOT NULL DEFAULT 0
      COMMENT 'giving - receiving + vat (정산 참고자료 합계)',
  `applied_price_percent`          DECIMAL(7,4) NULL COMMENT '거래 당시 수수료율(%) exact 스냅샷',
  `applied_price_adjustment`       VARCHAR(16)  NULL COMMENT 'DISCOUNT|ADDITIONAL',
  `applied_discount_history_id`    INT          NULL COMMENT 'FK) partner_discount_history.id',
  `pricing_resolution`             VARCHAR(24)  NULL COMMENT 'HISTORY_MATCH|NO_MATCH|DIRECT_AMOUNT',
  `settle_amount`                  BIGINT       NULL COMMENT 'base - discount - feeTotal',
  `idempotency_key`                VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `settle_batch_id`                INT          NULL COMMENT 'NULL = 미정산. FK 는 PR1D',
  `status`                         VARCHAR(16)  NOT NULL DEFAULT 'NORMAL' COMMENT 'NORMAL|NEEDS_REVIEW|ON_HOLD',
  `review_code`                    VARCHAR(32)  NULL
      COMMENT 'COVERAGE_GAP|TIME_UNRECOVERABLE|PRICE_UNRECOVERABLE|POLICY_CONFLICT|UNKNOWN_PROVIDER_EVENT',
  `review_resolution`              VARCHAR(16)  NULL COMMENT 'PENDING|DISCARDED',
  `resolved_by`                    INT          NULL COMMENT 'FK) user.id — DISCARDED 종결자',
  `resolved_at`                    DATETIME(6)  NULL,
  `provider_evidence_ref`          VARCHAR(255) NULL COMMENT '전이 해소 event 자기 증적 참조',
  `provider_evidence_hash`         VARCHAR(128) NULL COMMENT '전이 해소 event 자기 증적 정규화 hash',
  `memo`                           VARCHAR(1000) NULL,
  `reverses_ledger_id`             INT          NULL COMMENT '역분개 대상 원본 ledger id',
  `transition_observation_id`      INT          NULL COMMENT 'FK) partner_settle_transition_observation.id',
  `transition_sequence_no`         INT          NULL COMMENT '같은 observation 내 event 순번',
  `source_event_id_origin`         VARCHAR(16)  NULL COMMENT 'PROVIDER|MANUAL. 전이 event 필수',
  `review_resolution_id`           INT          NULL COMMENT 'FK 는 PR1C',
  `manual_ledger_proposal_id`      INT          NULL COMMENT 'FK 는 PR1C',
  `orphan_inbox_row_id`            INT          NULL COMMENT 'orphan lane inbox row (자동/수동 상호배타 축)',
  `payment_variance_proposal_id`   INT          NULL COMMENT 'FK·CHECK 일체는 PR3',
  -- 양수 정산 원장만 ingress 당 1건. 음수 배분(reversesLedgerId NOT NULL)은 UNIQUE 에서 빠진다 (63차-H2).
  `orphan_settlement_key`          INT
      GENERATED ALWAYS AS (CASE WHEN `reverses_ledger_id` IS NULL THEN `orphan_inbox_row_id` END) STORED,
  `created_at`                     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`                     DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_partner_settle_ledger_idempotency` (`idempotency_key`),
  UNIQUE KEY `uk_partner_settle_ledger_transition` (`transition_observation_id`, `transition_sequence_no`),
  UNIQUE KEY `uk_partner_settle_ledger_orphan_settlement` (`orphan_settlement_key`),
  KEY `idx_partner_settle_ledger_unsettled` (`partner_company_id`, `sub_item_key`, `settle_batch_id`),
  -- 확정 sweep 커버 인덱스: settle_batch_id IS NULL AND status='NORMAL' AND occurred_at < periodEnd
  KEY `idx_partner_settle_ledger_sweep`
    (`partner_company_id`, `settle_batch_id`, `status`, `occurred_at`, `id`),
  KEY `idx_partner_settle_ledger_occurred` (`occurred_at`),
  KEY `idx_partner_settle_ledger_delivery` (`order_delivery_id`),
  KEY `idx_partner_settle_ledger_reverses` (`reverses_ledger_id`),
  CONSTRAINT `fk_partner_settle_ledger_observation`
    FOREIGN KEY (`transition_observation_id`) REFERENCES `partner_settle_transition_observation` (`id`),
  -- orphan 정산 원장의 발송건은 반드시 inbox ingress row 와 일치해야 한다 (65차-H1).
  CONSTRAINT `fk_partner_settle_ledger_orphan_inbox`
    FOREIGN KEY (`orphan_inbox_row_id`, `order_delivery_id`)
    REFERENCES `partner_provider_event_inbox` (`id`, `order_delivery_id`),
  -- 상태 불변식: (status, reviewCode) 조합별 필수/금지 필드. NORMAL 인데 금액 NULL 인 채무 누락을 차단한다.
  CONSTRAINT `chk_partner_settle_ledger_status_fields`
    CHECK (
      (`status` = 'NORMAL'
        AND `occurred_at` IS NOT NULL AND `base_amount` IS NOT NULL
        AND `applied_price_percent` IS NOT NULL AND `applied_price_adjustment` IS NOT NULL
        AND `settle_amount` IS NOT NULL AND `review_code` IS NULL)
      OR
      (`status` = 'ON_HOLD'
        AND `occurred_at` IS NOT NULL AND `base_amount` IS NOT NULL
        AND `applied_price_percent` IS NOT NULL AND `applied_price_adjustment` IS NOT NULL
        AND `settle_amount` IS NOT NULL AND `review_code` IS NULL
        AND `settle_batch_id` IS NULL)
      OR
      (`status` = 'NEEDS_REVIEW' AND `settle_batch_id` IS NULL AND `settle_amount` IS NULL
        AND (
          (`review_code` IN ('COVERAGE_GAP','POLICY_CONFLICT')
            AND `occurred_at` IS NOT NULL AND `base_amount` IS NOT NULL
            AND `applied_price_percent` IS NULL AND `applied_price_adjustment` IS NULL)
          OR
          (`review_code` = 'TIME_UNRECOVERABLE'
            AND `occurred_at` IS NULL AND `base_amount` IS NOT NULL)
          OR
          (`review_code` = 'PRICE_UNRECOVERABLE'
            AND `occurred_at` IS NOT NULL AND `base_amount` IS NULL)
          OR
          (`review_code` = 'UNKNOWN_PROVIDER_EVENT'
            AND `base_amount` IS NULL
            AND `applied_price_percent` IS NULL AND `applied_price_adjustment` IS NULL)
        ))
    ),
  -- 정당한 0% 무매칭 / history FK 유실 버그 / 조정 직접저장을 DB 가 구별한다 (29차-7·30차-2).
  CONSTRAINT `chk_partner_settle_ledger_pricing_resolution`
    CHECK (
      (`status` = 'NEEDS_REVIEW' AND `pricing_resolution` IS NULL)
      OR
      (`status` IN ('NORMAL','ON_HOLD')
        AND `pricing_resolution` IN ('HISTORY_MATCH','NO_MATCH','DIRECT_AMOUNT')
        AND (`pricing_resolution` <> 'HISTORY_MATCH' OR `applied_discount_history_id` IS NOT NULL)
        AND (`pricing_resolution` <> 'NO_MATCH'
             OR (`applied_discount_history_id` IS NULL
                 AND `applied_price_percent` = 0
                 AND `applied_price_adjustment` = 'DISCOUNT'))
        AND (`source_type` <> 'ADJUSTMENT' OR `pricing_resolution` = 'DIRECT_AMOUNT')
        AND (`pricing_resolution` <> 'DIRECT_AMOUNT'
             OR (`source_type` = 'ADJUSTMENT'
                 AND `applied_discount_history_id` IS NULL
                 AND `applied_price_percent` = 0
                 AND `applied_price_adjustment` = 'DISCOUNT'
                 AND `base_amount` = `settle_amount`)))
    ),
  -- 격리 종결 상태 조합 (23차·24차). DISCARDED 는 UNKNOWN_PROVIDER_EVENT 전용 + 증적 필수.
  CONSTRAINT `chk_partner_settle_ledger_review_resolution`
    CHECK (
      (`status` IN ('NORMAL','ON_HOLD')
        AND `review_resolution` IS NULL AND `resolved_by` IS NULL AND `resolved_at` IS NULL)
      OR
      (`status` = 'NEEDS_REVIEW'
        AND (
          (`review_resolution` = 'PENDING' AND `resolved_by` IS NULL AND `resolved_at` IS NULL)
          OR
          (`review_resolution` = 'DISCARDED'
            AND `review_code` = 'UNKNOWN_PROVIDER_EVENT'
            AND `resolved_by` IS NOT NULL AND `resolved_at` IS NOT NULL AND `memo` IS NOT NULL)
        ))
    ),
  -- 전이 감지 event 는 observation·순번·origin 을 함께 가진다 (13차·17차 P4·56차-H2).
  CONSTRAINT `chk_partner_settle_ledger_transition_pair`
    CHECK (
      (`transition_observation_id` IS NULL) = (`transition_sequence_no` IS NULL)
      AND (`transition_observation_id` IS NULL OR `source_event_id_origin` IS NOT NULL)
    ),
  CONSTRAINT `chk_partner_settle_ledger_status_enum`
    CHECK (`status` IN ('NORMAL','NEEDS_REVIEW','ON_HOLD')),
  CONSTRAINT `chk_partner_settle_ledger_source_type_enum`
    CHECK (`source_type` IN ('ISSUANCE','EXCHANGE','USAGE','ADJUSTMENT')),
  -- USAGE 만 일대사 로그를 근거로 갖는다.
  CONSTRAINT `chk_partner_settle_ledger_galaxia_log`
    CHECK (`galaxia_barcode_log_id` IS NULL OR `source_type` = 'USAGE'),
  -- ISSUANCE/EXCHANGE/USAGE 는 발송건 필수. ADJUSTMENT 만 NULL 허용.
  CONSTRAINT `chk_partner_settle_ledger_delivery_required`
    CHECK (`source_type` = 'ADJUSTMENT' OR `order_delivery_id` IS NOT NULL),
  -- 단건 금액 상한 (57차-H3 ①). 집계·계산 상한은 서비스에서 422 로 막는다.
  CONSTRAINT `chk_partner_settle_ledger_amount_bound`
    CHECK (
      (`base_amount`   IS NULL OR ABS(`base_amount`)   <= 1000000000000000)
      AND (`settle_amount` IS NULL OR ABS(`settle_amount`) <= 1000000000000000)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 정산 이벤트 원장 (SoT · append-only · 사실/금액 필드 불변)';

-- ---------------------------------------------------------------------------
-- 4. galaxia_barcode_log — 시각 완비 event 의 멱등 identity
--    ⚠️ 선행: 아래 preflight 가 0건이어야 이 ALTER 가 성공한다 (65차-M2·66차-H3).
--
--    SELECT barcode, gift_kind, app_div, app_day, app_time, COALESCE(app_no,'-') AS app_no, amount,
--           COUNT(*) AS c
--      FROM galaxia_barcode_log
--     WHERE deleted_at IS NULL AND app_day IS NOT NULL AND app_time IS NOT NULL
--     GROUP BY 1,2,3,4,5,6,7 HAVING c > 1;
--
--    중복 처리: 진짜 재수신 = 1건 유지·나머지 soft-delete(tombstone → active_event_fingerprint NULL),
--               비시각 필드가 상이한 실사건 = 운영자 판정(orphan lane 이관).
--    UNIQUE 는 raw fingerprint 가 아니라 soft-delete 제외 generated 컬럼에 건다.
-- ---------------------------------------------------------------------------
ALTER TABLE `galaxia_barcode_log`
  ADD COLUMN `event_fingerprint` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    GENERATED ALWAYS AS (
      CASE WHEN `app_day` IS NOT NULL AND `app_time` IS NOT NULL
           THEN CONCAT_WS('|', `barcode`, `gift_kind`, `app_div`, `app_day`, `app_time`,
                          COALESCE(`app_no`, '-'), CAST(`amount` AS CHAR))
      END
    ) STORED COMMENT '시각 완비 event 의 멱등 identity (7필드). 시각 누락 = NULL',
  ADD COLUMN `active_event_fingerprint` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    GENERATED ALWAYS AS (
      CASE WHEN `deleted_at` IS NULL THEN
        CASE WHEN `app_day` IS NOT NULL AND `app_time` IS NOT NULL
             THEN CONCAT_WS('|', `barcode`, `gift_kind`, `app_div`, `app_day`, `app_time`,
                            COALESCE(`app_no`, '-'), CAST(`amount` AS CHAR))
        END
      END
    ) STORED COMMENT 'soft-delete 제외 fingerprint — UNIQUE 대상';

ALTER TABLE `galaxia_barcode_log`
  ADD UNIQUE KEY `uk_galaxia_barcode_log_active_event_fingerprint` (`active_event_fingerprint`);
