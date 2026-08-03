-- 프리미엄 발송실패 추적·재발송 §10 2단계(shadow 추적) 스키마
-- 근거: plans/프리미엄_발송실패_재발송_구상.md §5(4개 상태 머신) / §6(2계층 선점) /
--       §7.3(결과 파티션 증분 탐색) / §8.2(DUAL_APPROVAL) / §9(감사·검증 스키마) / §10(불변식 SQL)
-- ============================================================================
-- 이 마이그레이션은 additive only 다. 기존 테이블/컬럼/로직 변경 없음.
-- 이 단계에서 자동 재발송은 활성화하지 않는다(shadow 추적 전용, §10 2단계).
--
-- 상태 머신 4개 = delivery_workflow(전체 업무) / pin_issue_command(PIN 발급 명령)
--                / message_attempt(개별 메시지 시도) / refund_attempt(환불 외부 부작용)
-- 감사·검증 3종 = dual_approval(+audit) / workflow_resolution / stale_external_response
--
-- 환경: MySQL 8.x / MariaDB 10.x 공용 / ENGINE=InnoDB / utf8mb4. FK 제약은 이 저장소 관례대로 두지 않는다(논리 FK).
--       생성 컬럼 식은 **결과에 문자열 리터럴을 넣지 않는다** — MariaDB 가 세션 collation 의존으로 거부한다(오류 1901).
-- ============================================================================


-- ============================================================================
-- M1. delivery_workflow — 전체 업무 상태 + Level A 배타 슬롯 앵커 (§5.1·§6.1)
--   order_delivery 1:1 (쿠폰 단위). 배타 슬롯·fencing 카운터가 모든 동시성 제어의 앵커다.
-- ============================================================================
CREATE TABLE `delivery_workflow` (
  `id`                         BIGINT       NOT NULL AUTO_INCREMENT,
  `order_delivery_id`          INT          NOT NULL                      COMMENT 'FK) order_delivery.id (1:1, 쿠폰 단위)',
  `workflow_status`            VARCHAR(32)  NOT NULL DEFAULT 'IN_PROGRESS'
      COMMENT 'IN_PROGRESS|PENDING_RECONCILE|OPS_REVIEW_REQUIRED|COMPLETED|FAILED_FINAL|CANCELLED|RESOLVED_MANUALLY_SUCCESS|RESOLVED_MANUALLY_FAILED|RESOLVED_MANUALLY_REFUNDED',
  `workflow_version`           BIGINT       NOT NULL DEFAULT 0            COMMENT 'fencing 카운터. 슬롯 점유/해제/전이마다 +1 (§6.1)',
  `active_exclusive_op`        VARCHAR(24)  NULL                          COMMENT 'Level A 배타 슬롯 점유 op. NULL=공석 (§6.1 표 2-1)',
  `exclusive_owner_token`      VARCHAR(64)  NULL                          COMMENT '슬롯 소유자 토큰(ABA 방지)',
  `exclusive_lease_expires_at` DATETIME(6)  NULL                          COMMENT '슬롯 리스 만료 시각. 경과 시 회수 가능',
  `delivered_flag`             TINYINT(1)   NOT NULL DEFAULT 0            COMMENT '쿠폰 단위 전달완료 플래그 (§3 나, 채널 하나라도 최종 성공)',
  `delivered_channel`          VARCHAR(16)  NULL                          COMMENT '전달 성공 채널 ALIM_TALK|SMS|MMS|EMAIL',
  `delivered_at`               DATETIME(6)  NULL,
  `settled_refund_attempt_id`  BIGINT       NULL                          COMMENT 'RESOLVED_MANUALLY_REFUNDED 종결 근거의 단일 출처 (§5.1·HIGH 1)',
  `refunded_at`                DATETIME(6)  NULL                          COMMENT '환불 확정 표식(경로 B 포함). 재발송 후보 영구 제외 (§6.1 환불 가드)',
  `refund_status`              VARCHAR(16)  NULL                          COMMENT '환불 표식 상태 SUCCEEDED|FAILED|UNKNOWN',
  `cancel_reason_code`         VARCHAR(32)  NULL                          COMMENT 'CANCELLED 종결 사유 코드 (§5.1·§7.2)',
  `state_entered_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                                                          COMMENT '현재 workflow_status 진입 시각(SLA 체류시간 판정 기준, 표 4-1)',
  `ops_escalated_at`           DATETIME(6)  NULL                          COMMENT 'OPS_REVIEW_REQUIRED 승격 시각(에스컬레이션 SLA 기준)',
  `ops_review_reason`          VARCHAR(32)  NULL                          COMMENT 'SLA_EXCEEDED|LATE_RESULT_REVIEW|REISSUE_REVIEW|REFUND_UNKNOWN 등',
  `cutover_draining_at`        DATETIME(6)  NULL                          COMMENT '컷오버 드레이닝 마크. NOT NULL 이면 legacy 신규 진입을 거부하되 신규 모델도 아직 시작하지 않는다(quiesce 구간, §9)',
  `cutover_migrated_at`        DATETIME(6)  NULL                          COMMENT '컷오버 전환 마크. NOT NULL 이면 legacy 진입점 거부 + workflow 가 유일 SoT (§8·§9)',
  `created_at`                 DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                 DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_delivery_workflow_delivery` (`order_delivery_id`),
  KEY `idx_delivery_workflow_status` (`workflow_status`, `state_entered_at`),
  KEY `idx_delivery_workflow_slot` (`active_exclusive_op`, `exclusive_lease_expires_at`),
  KEY `idx_delivery_workflow_cutover` (`cutover_migrated_at`),
  KEY `idx_delivery_workflow_draining` (`cutover_draining_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='발송 workflow 전체 상태 + Level A 배타 슬롯 앵커';

-- M1 검증
-- SHOW CREATE TABLE `delivery_workflow`;
-- 슬롯 누수 감시(§10 2단계 PASS):
--   SELECT COUNT(*) FROM delivery_workflow
--    WHERE active_exclusive_op IS NOT NULL AND exclusive_lease_expires_at < NOW() - INTERVAL 1 HOUR;  -- 0
-- M1 롤백: DROP TABLE IF EXISTS `delivery_workflow`;


-- ============================================================================
-- M2. pin_issue_command — PIN 발급 명령 상태 (§5.2)
--   최초 발급(PIN_ISSUE)은 order_delivery 당 1건만 허용(생성 컬럼 unique).
--   재시도(RETRY)·재발급(PIN_REISSUE)은 별도 행을 만들 수 있다.
-- ============================================================================
CREATE TABLE `pin_issue_command` (
  `id`                        BIGINT       NOT NULL AUTO_INCREMENT,
  `order_delivery_id`         INT          NOT NULL                       COMMENT 'FK) order_delivery.id',
  `status`                    VARCHAR(24)  NOT NULL DEFAULT 'STARTED'
      COMMENT 'STARTED|RETRY_PENDING|RECONCILING|RETRYING|SUCCEEDED|TERMINAL|EXHAUSTED|UNKNOWN_DEFERRED',
  `partner_type`              VARCHAR(32)  NOT NULL                       COMMENT '협력사 타입 GALAXIA|GIFT_SHOW|DAOU|GIFTIEL|CULTURELAND|SSG',
  `request_key`               VARCHAR(191) NULL                           COMMENT '협력사 요청 키(trId 등). 멱등/조회 키 (§9 협력사 PIN 정책)',
  `attempt_count`             INT          NOT NULL DEFAULT 0             COMMENT '협력사 발급 호출 횟수',
  `partner_response_code`     VARCHAR(32)  NULL                           COMMENT 'PARTNER_RESPONSE_* 원본 응답코드',
  `response_class`            VARCHAR(16)  NULL                           COMMENT 'SUCCESS|DUPLICATE|RETRYABLE|TERMINAL|UNKNOWN (§9 분류표)',
  `owner_token`               VARCHAR(64)  NULL                           COMMENT 'Level B 실행 lease 소유자',
  `generation`                BIGINT       NOT NULL DEFAULT 0             COMMENT 'Level B 세대(3중 fencing)',
  `workflow_version`          BIGINT       NULL                           COMMENT '바인딩된 delivery_workflow.workflow_version(3중 fencing)',
  `created_by_op`             VARCHAR(24)  NOT NULL                       COMMENT '생성 출처 op PIN_ISSUE|RETRY|PIN_REISSUE, 컷오버 이전 legacy 경로는 LEGACY_SEND (§5.2·MEDIUM 3)',
  `created_workflow_version`  BIGINT       NOT NULL                       COMMENT '생성 시점 workflow_version(승인 대조 조인 키)',
  `approval_id`               BIGINT       NULL                           COMMENT 'DUAL op(PIN_REISSUE)만 필수. dual_approval.id',
  `next_attempt_at`           DATETIME(6)  NULL                           COMMENT 'RETRY_PENDING 재시도 예정 시각',
  `state_entered_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '현재 status 진입 시각(표 4-1 체류시간)',
  `resolved_at`               DATETIME(6)  NULL                           COMMENT '터미널 확정 시각',
  -- 최초 발급 명령은 order_delivery 당 1건 (§6.1 PIN_ISSUE 가드의 DB 보강)
  `initial_issue_key`         INT
      GENERATED ALWAYS AS (CASE WHEN `created_by_op` = 'PIN_ISSUE' THEN `order_delivery_id` END) STORED
      COMMENT '최초 발급 명령 단일성 보조(그 외 op 는 NULL)',
  `created_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pin_issue_command_initial` (`initial_issue_key`),
  KEY `idx_pin_issue_command_delivery` (`order_delivery_id`, `status`),
  KEY `idx_pin_issue_command_status` (`status`, `state_entered_at`),
  KEY `idx_pin_issue_command_due` (`status`, `next_attempt_at`),
  KEY `idx_pin_issue_command_approval` (`approval_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='협력사 PIN 발급 명령 상태 머신';

-- M2 검증
-- 승인 없는 재발급 탐지(§10 불변식 ②-c) 는 created_by_op/approval_id 로 수행한다.
-- M2 롤백: DROP TABLE IF EXISTS `pin_issue_command`;


-- ============================================================================
-- M3. message_attempt — 알림톡/SMS/MMS 개별 시도 상태 (§5.3)
--   attempt_id = Gemtek EXT_COL2 상관키(무작위 UUID hex 32자, 개인정보 미포함, §9 DBA 계약).
--   재발송은 MSEQ 교체가 아니라 retry_of_attempt_id 로 연결된 새 행이다.
-- ============================================================================
CREATE TABLE `message_attempt` (
  `id`                        BIGINT       NOT NULL AUTO_INCREMENT,
  `attempt_id`                CHAR(32)     NOT NULL                       COMMENT '상관키(EXT_COL2). 무작위 UUID hex 32자',
  `order_delivery_id`         INT          NOT NULL                       COMMENT 'FK) order_delivery.id',
  `channel`                   VARCHAR(16)  NOT NULL                       COMMENT 'SMS|MMS|ALIM_TALK',
  `attempt_type`              VARCHAR(24)  NOT NULL                       COMMENT 'INITIAL|AUTO_504|CHANNEL_FALLBACK|MANUAL_RESEND (§5.3 표)',
  `attempt_seq`               INT          NOT NULL DEFAULT 1             COMMENT '동일 유형 내 순번(MANUAL_RESEND 다회 허용)',
  `retry_of_attempt_id`       CHAR(32)     NULL                           COMMENT '직전 시도 attempt_id. NULL 이면 최초 시도',
  `root_attempt_id`           CHAR(32)     NOT NULL                       COMMENT '체인 식별자(최초 시도의 attempt_id 상속)',
  `status`                    VARCHAR(24)  NOT NULL DEFAULT 'OUTBOX_READY'
      COMMENT 'OUTBOX_READY|SUBMITTING|SUBMITTED|TRACKING|RECONCILING|RETRY_SCHEDULED|RETRIED|CANCELLED_SUPERSEDED|SUCCEEDED|FAILED_FINAL|UNKNOWN',
  `send_reason`               VARCHAR(32)  NULL                           COMMENT '발송 원인 PIN|ALIM_TALK_FALLBACK|MANUAL 등 화면 노출용 (§8)',
  `mseq`                      BIGINT       NULL                           COMMENT 'Gemtek MSG_QUEUE.MSEQ (insert OUTPUT 로 확보)',
  `gemtek_stat`               VARCHAR(4)   NULL                           COMMENT '원본 STAT (확정 여부)',
  `gemtek_result`             VARCHAR(8)   NULL                           COMMENT '원본 RESULT (GEMTEK_RESULT_*)',
  `send_time`                 DATETIME(6)  NULL                           COMMENT 'Gemtek SEND_TIME',
  `report_time`               DATETIME(6)  NULL                           COMMENT 'Gemtek REPORT_TIME(확정 시각)',
  `receipt_month`             CHAR(6)      NULL                           COMMENT '접수월 yyyyMM (MSEQ 채번월, §7.3)',
  `last_searched_month`       CHAR(6)      NULL                           COMMENT '마지막 조회 완료 월 (§7.3)',
  `next_search_month`         CHAR(6)      NULL                           COMMENT '다음 사이클 조회 시작 월 (§7.3)',
  `next_attempt_at`           DATETIME(6)  NULL                           COMMENT 'RETRY_SCHEDULED 재발송 예정 시각 (§7.2 심야 정책 반영값)',
  `retry_deadline_at`         DATETIME(6)  NULL                           COMMENT '재발송 가능 기한 = 실패 확정 시각 + 24h (§7.2). 예약 만료 판정의 단일 기준',
  `late_result_at`            DATETIME(6)  NULL                           COMMENT 'UNKNOWN 승격 후 지연 확정 결과가 도착한 시각(LATE_RESULT_REVIEW, §7.1·§7.3). 자동 종결 금지 표식',
  `owner_token`               VARCHAR(64)  NULL                           COMMENT 'Level B 실행 lease 소유자',
  `generation`                BIGINT       NOT NULL DEFAULT 0             COMMENT 'Level B 세대(3중 fencing)',
  `workflow_version`          BIGINT       NULL                           COMMENT '바인딩된 workflow_version(3중 fencing)',
  `created_by_op`             VARCHAR(24)  NOT NULL                       COMMENT '생성 출처 op MESSAGE_SEND|RETRY|MANUAL_RESEND, 컷오버 이전 legacy 경로는 LEGACY_SEND (§3 다·HIGH 2)',
  `created_workflow_version`  BIGINT       NOT NULL                       COMMENT '생성 시점 workflow_version(승인 대조 조인 키)',
  `approval_id`               BIGINT       NULL                           COMMENT 'DUAL op(MANUAL_RESEND)만 필수. dual_approval.id',
  `cancel_requested_at`       DATETIME(6)  NULL                           COMMENT 'durable cancel intent 커밋 시각 (§5.3 HIGH 3)',
  `cancel_reason`             VARCHAR(32)  NULL                           COMMENT 'OTHER_CHANNEL_DELIVERED|ORDER_CANCELLED 등',
  `cancel_resolution`         VARCHAR(24)  NULL
      COMMENT 'CANCELLED|ACCEPTED_DUPLICATE|TOO_LATE_DELIVERED|UNKNOWN_REQUIRES_OPS|OPS_CLOSED (열린 intent 금지, §10 불변식 ③)',
  `state_entered_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '현재 status 진입 시각(표 4-1 체류시간)',
  `resolved_at`               DATETIME(6)  NULL                           COMMENT '터미널 확정 시각',
  -- 유형별 재발송 허용 횟수 강제 (§5.3 표): AUTO_504=체인당 1회, CHANNEL_FALLBACK=원 attempt 당 1회,
  -- MANUAL_RESEND=원 attempt 당 다회(attempt_seq 포함), INITIAL=제약 없음(NULL 다중 허용).
  --
  -- ⚠ 생성 컬럼에 문자열 리터럴을 **결과로** 넣지 않는다: MariaDB 는 식의 결과 collation 이
  --   세션(`character_set_connection`)에 의존하면 거부한다(오류 1901). 그래서 유형 접두사를 붙인
  --   CONCAT 대신 **유형별 컬럼을 나눠 컬럼 값을 그대로 돌려주는 CASE** 를 쓴다.
  --   (`WHEN 'AUTO_504'` 처럼 비교에만 쓰는 리터럴은 결과에 들어가지 않아 허용된다 — 같은 패턴이
  --    `product.ssg_price_key`(20260617)에 이미 적용돼 있다.)
  --
  -- ⚠ NULL 부모 주의: unique 인덱스는 NULL 을 다중 허용하므로 `retry_of_attempt_id` 가 NULL 이면
  --   제약이 조용히 무력화된다. 정상 흐름에서는 알림톡 시도도 추적하므로 CHANNEL_FALLBACK 은 항상
  --   부모를 갖지만, 추적 공백(알림톡 행 생성 실패 등)에 대비해 **부모 없는 폴백은 쿠폰 범위 키**로
  --   따로 잡는다(`fallback_delivery_key`).
  `auto504_chain_key`         CHAR(32)
      GENERATED ALWAYS AS (CASE WHEN `attempt_type` = 'AUTO_504' THEN `root_attempt_id` END) STORED
      COMMENT 'AUTO_504 체인당 1회 보조 (§5.3)',
  `fallback_parent_key`       CHAR(32)
      GENERATED ALWAYS AS (CASE WHEN `attempt_type` = 'CHANNEL_FALLBACK' THEN `retry_of_attempt_id` END) STORED
      COMMENT 'CHANNEL_FALLBACK 원 attempt 당 1회 보조',
  `fallback_delivery_key`     INT
      GENERATED ALWAYS AS (
        CASE WHEN `attempt_type` = 'CHANNEL_FALLBACK' AND `retry_of_attempt_id` IS NULL
             THEN `order_delivery_id` END
      ) STORED
      COMMENT '부모 없는 폴백의 쿠폰당 1회 보조(추적 공백 대비)',
  `manual_resend_parent_key`  CHAR(32)
      GENERATED ALWAYS AS (CASE WHEN `attempt_type` = 'MANUAL_RESEND' THEN `retry_of_attempt_id` END) STORED
      COMMENT 'MANUAL_RESEND 다회 허용 — attempt_seq 와 조합해 같은 순번 중복만 차단',
  `created_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_message_attempt_attempt_id` (`attempt_id`),
  UNIQUE KEY `uk_message_attempt_auto504` (`auto504_chain_key`),
  UNIQUE KEY `uk_message_attempt_fallback` (`fallback_parent_key`),
  UNIQUE KEY `uk_message_attempt_fallback_od` (`fallback_delivery_key`),
  UNIQUE KEY `uk_message_attempt_manual` (`manual_resend_parent_key`, `attempt_seq`),
  KEY `idx_message_attempt_delivery` (`order_delivery_id`, `status`),
  KEY `idx_message_attempt_status` (`status`, `state_entered_at`),
  KEY `idx_message_attempt_due` (`status`, `next_attempt_at`),
  KEY `idx_message_attempt_mseq` (`mseq`),
  KEY `idx_message_attempt_root` (`root_attempt_id`, `attempt_type`),
  KEY `idx_message_attempt_cancel` (`cancel_requested_at`, `cancel_resolution`),
  KEY `idx_message_attempt_approval` (`approval_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='메시지(알림톡/SMS/MMS) 개별 시도 상태 머신';

-- M3 주석: created_by_op = LEGACY_SEND 는 컷오버 이전 legacy 발송 경로가 만든 관찰용 행이다.
--   전환 마크(delivery_workflow.cutover_migrated_at)가 없는 건은 기존 claimedAt 이 유일한 동시성 모델이라
--   Level A 슬롯·op 가드의 적용 대상이 아니므로, §10 불변식 ②/②-b 집계에서 제외한다
--   (불변식 SQL 의 created_by_op IN ('MESSAGE_SEND','RETRY') / = 'MANUAL_RESEND' 필터가 자연히 걸러낸다).
-- M3 검증
-- 상관키 유일성(§10 2단계 PASS): SELECT attempt_id FROM message_attempt GROUP BY attempt_id HAVING COUNT(*) > 1; -- 0행
-- 체인당 AUTO_504 1회(§10 4단계 PASS, uk_message_attempt_auto504 가 물리 강제):
--   SELECT root_attempt_id FROM message_attempt WHERE attempt_type='AUTO_504' GROUP BY root_attempt_id HAVING COUNT(*)>1; -- 0행
-- M3 롤백: DROP TABLE IF EXISTS `message_attempt`;


-- ============================================================================
-- M4. refund_attempt — 환불 외부 부작용 상태 머신 (§5.4)
--   미확정(CLAIMED/SUBMITTING/RECONCILING/UNKNOWN)은 order_delivery 당 최대 1건(단일 in-flight).
--   FAILED(외부 미실행 확정) 이후에만 신규 attempt 를 열 수 있다. UNKNOWN 이후에는 금지.
-- ============================================================================
CREATE TABLE `refund_attempt` (
  `id`                        BIGINT       NOT NULL AUTO_INCREMENT,
  `order_delivery_id`         INT          NOT NULL                       COMMENT 'FK) order_delivery.id',
  `status`                    VARCHAR(16)  NOT NULL DEFAULT 'CLAIMED'
      COMMENT 'CLAIMED|SUBMITTING|RECONCILING|SUCCEEDED|FAILED|UNKNOWN',
  `entry_path`                CHAR(1)      NOT NULL                       COMMENT 'A=OPS_REVIEW_REQUIRED 경유(DUAL) / B=종결 상태 환불(슬롯 fencing) (§5.4)',
  `amount`                    INT          NOT NULL                       COMMENT '환불 금액(승인 payload 와 대조, §10 불변식 ①)',
  `scope`                     VARCHAR(16)  NOT NULL                       COMMENT 'FULL|PARTIAL',
  `external_idempotency_key`  VARCHAR(191) NOT NULL                       COMMENT '외부 환불 idempotency key(중복 환불 방지)',
  `owner_token`               VARCHAR(64)  NULL                           COMMENT 'Level B 실행 lease 소유자',
  `generation`                BIGINT       NOT NULL DEFAULT 0             COMMENT 'Level B 세대(3중 fencing)',
  `workflow_version`          BIGINT       NULL                           COMMENT '바인딩된 workflow_version(3중 fencing)',
  `approval_id`               BIGINT       NULL                           COMMENT '경로 A 의 DUAL claim 승인 id. 경로 B 는 NULL (§5.4)',
  `created_by_op`             VARCHAR(24)  NOT NULL DEFAULT 'REFUND'      COMMENT '생성 출처 op(감사 일관성)',
  `created_workflow_version`  BIGINT       NOT NULL                       COMMENT '생성 시점 workflow_version',
  `failure_reason`            VARCHAR(500) NULL                           COMMENT 'FAILED/UNKNOWN 사유(민감정보 금지, §8.3)',
  `state_entered_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '현재 status 진입 시각(표 4-1 체류시간)',
  `resolved_at`               DATETIME(6)  NULL,
  -- 단일 in-flight 강제: 미확정 상태에서만 order_delivery_id 를 노출해 unique 충돌시킨다.
  `in_flight_key`             INT
      GENERATED ALWAYS AS (
        CASE WHEN `status` IN ('CLAIMED','SUBMITTING','RECONCILING','UNKNOWN') THEN `order_delivery_id` END
      ) STORED
      COMMENT '미확정 환불 단일성 보조(§5.4). 터미널(SUCCEEDED/FAILED)은 NULL',
  `created_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_refund_attempt_idem` (`external_idempotency_key`),
  UNIQUE KEY `uk_refund_attempt_in_flight` (`in_flight_key`),
  KEY `idx_refund_attempt_delivery` (`order_delivery_id`, `status`),
  KEY `idx_refund_attempt_status` (`status`, `state_entered_at`),
  KEY `idx_refund_attempt_approval` (`approval_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='환불 외부 부작용 상태 머신(4번째 상태 머신)';

-- M4 검증
-- 중복 환불 0건(§10 4단계 PASS): 미확정 refund_attempt 2개 이상 보유 order_delivery → uk 로 물리 차단.
-- M4 롤백: DROP TABLE IF EXISTS `refund_attempt`;


-- ============================================================================
-- M5. dual_approval — four-eyes 승인 (§8.2)
--   승인은 op 단위로만 유효하며 다른 op 로 전용될 수 없다(§10 공통 규칙 op fencing).
--   payload_hash 는 위·변조 검증용이고, 사후 대조를 위해 실행 대상 값을 컬럼으로 materialize 한다(MEDIUM 1).
-- ============================================================================
CREATE TABLE `dual_approval` (
  `id`                       BIGINT       NOT NULL AUTO_INCREMENT,
  `order_delivery_id`        INT          NOT NULL                        COMMENT 'FK) order_delivery.id (포괄 승인 금지)',
  `op`                       VARCHAR(24)  NOT NULL                        COMMENT 'OPS_RESOLVE|MANUAL_RESEND|PIN_REISSUE|REFUND',
  `status`                   VARCHAR(16)  NOT NULL DEFAULT 'PENDING'      COMMENT 'PENDING|APPROVED|REJECTED|INVALIDATED|CONSUMED',
  `payload_hash`             CHAR(64)     NOT NULL                        COMMENT '승인 payload SHA-256(위·변조 검증)',
  `bound_workflow_version`   BIGINT       NOT NULL                        COMMENT '승인이 바인딩한 workflow_version. 변동 시 자동 무효화',
  `resolved_status`          VARCHAR(32)  NULL                            COMMENT 'OPS_RESOLVE 승인 시 목표 종결 상태',
  `refund_attempt_id`        BIGINT       NULL                            COMMENT 'OPS_RESOLVE(REFUNDED) 근거로 지목한 refund_attempt.id',
  `amount`                   INT          NULL                            COMMENT 'REFUND/환불 종결 승인 금액',
  `scope`                    VARCHAR(16)  NULL                            COMMENT 'FULL|PARTIAL',
  `external_idempotency_key` VARCHAR(191) NULL                            COMMENT 'REFUND 승인 payload 의 외부 idempotency key',
  `requested_by`             INT          NOT NULL                        COMMENT '요청자 user.id',
  `requested_reason`         VARCHAR(500) NOT NULL                        COMMENT '요청 사유(필수)',
  `first_approver_id`        INT          NULL                            COMMENT '1차 승인자(요청자와 달라야 함)',
  `second_approver_id`       INT          NULL                            COMMENT '2차 승인자(요청자·1차와 달라야 함)',
  `first_approved_at`        DATETIME(6)  NULL,
  `second_approved_at`       DATETIME(6)  NULL,
  `expires_at`               DATETIME(6)  NOT NULL                        COMMENT '승인 만료 시각. 만료 후 실행 불가',
  `consumed_at`              DATETIME(6)  NULL                            COMMENT '실행에 사용된 시각(1회성)',
  `created_at`               DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`               DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_dual_approval_target` (`order_delivery_id`, `op`, `status`),
  KEY `idx_dual_approval_version` (`order_delivery_id`, `bound_workflow_version`),
  KEY `idx_dual_approval_expires` (`status`, `expires_at`),
  CONSTRAINT `ck_dual_approval_first_not_requester`  CHECK (`first_approver_id`  IS NULL OR `first_approver_id`  <> `requested_by`),
  CONSTRAINT `ck_dual_approval_second_not_requester` CHECK (`second_approver_id` IS NULL OR `second_approver_id` <> `requested_by`),
  CONSTRAINT `ck_dual_approval_two_persons`          CHECK (`second_approver_id` IS NULL OR `second_approver_id` <> `first_approver_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DUAL_APPROVAL(four-eyes) 승인 레코드';

-- M5 검증
-- self-approval 차단: requested_by = first_approver_id 로 UPDATE → CHECK 위반.
-- M5 롤백: DROP TABLE IF EXISTS `dual_approval`;


-- ============================================================================
-- M6. dual_approval_audit — 승인 흐름 append-only 감사 로그 (§8.2)
--   요청·1차·2차·최종 종결·무효화를 각각 남긴다. UPDATE/DELETE 금지(애플리케이션 규약).
-- ============================================================================
CREATE TABLE `dual_approval_audit` (
  `id`            BIGINT       NOT NULL AUTO_INCREMENT,
  `approval_id`   BIGINT       NOT NULL                                   COMMENT 'FK) dual_approval.id',
  `event`         VARCHAR(24)  NOT NULL                                   COMMENT 'REQUESTED|APPROVED_FIRST|APPROVED_SECOND|REJECTED|INVALIDATED|CONSUMED',
  `actor_user_id` INT          NULL                                       COMMENT '행위자 user.id (시스템 무효화는 NULL)',
  `payload_hash`  CHAR(64)     NOT NULL                                   COMMENT '이벤트 시점 payload hash',
  `reason`        VARCHAR(500) NULL                                       COMMENT '사유(민감정보 금지, §8.3)',
  `created_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_dual_approval_audit_approval` (`approval_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DUAL_APPROVAL append-only 감사 로그';

-- M6 롤백: DROP TABLE IF EXISTS `dual_approval_audit`;


-- ============================================================================
-- M7. workflow_resolution — 불변 수동 종결 레코드 (§7.1)
--   존재하면 자동 계산 로직은 workflow 상태를 재계산하지 않는다(불변 override).
--   MANUAL_RESEND/PIN_REISSUE 재개는 이 레코드를 만들지 않는다(§6.2 경로별 후처리).
-- ============================================================================
CREATE TABLE `workflow_resolution` (
  `id`                        BIGINT       NOT NULL AUTO_INCREMENT,
  `order_delivery_id`         INT          NOT NULL                       COMMENT 'FK) order_delivery.id (1건만 존재)',
  `resolved_status`           VARCHAR(32)  NOT NULL                       COMMENT 'RESOLVED_MANUALLY_SUCCESS|RESOLVED_MANUALLY_FAILED|RESOLVED_MANUALLY_REFUNDED',
  `approval_id`               BIGINT       NOT NULL                       COMMENT '종결 근거 승인(op=OPS_RESOLVE)',
  `settled_refund_attempt_id` BIGINT       NULL                           COMMENT '환불 종결일 때 근거 refund_attempt.id (§10 불변식 ①)',
  `payload_hash`              CHAR(64)     NOT NULL                       COMMENT '승인 payload hash',
  `workflow_version`          BIGINT       NOT NULL                       COMMENT '종결 시점 workflow_version',
  `resolved_by`               INT          NOT NULL                       COMMENT '최종 종결 실행자 user.id',
  `evidence`                  VARCHAR(1000) NOT NULL                      COMMENT '근거(협력사 조회 결과·STAT/RESULT·고객 확인 등, 민감정보 금지)',
  `created_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workflow_resolution_delivery` (`order_delivery_id`),
  KEY `idx_workflow_resolution_approval` (`approval_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='불변 수동 종결 레코드(하위 결과로 재계산되지 않음)';

-- M7 롤백: DROP TABLE IF EXISTS `workflow_resolution`;


-- ============================================================================
-- M8. stale_external_response — fencing 불일치 응답 보관 (§6.1·§8.3)
--   3중 fencing 불일치 응답은 폐기하지 않고 여기 저장한 뒤 재조정 신호를 낸다.
--   본문은 애플리케이션에서 암호화해 저장하고, 추적키(비민감)만 평문 인덱스로 둔다.
-- ============================================================================
CREATE TABLE `stale_external_response` (
  `id`                 BIGINT       NOT NULL AUTO_INCREMENT,
  `order_delivery_id`  INT          NULL                                  COMMENT 'FK) order_delivery.id (식별 가능한 경우)',
  `state_machine`      VARCHAR(16)  NOT NULL                              COMMENT 'PIN|MESSAGE|REFUND',
  `target_key`         VARCHAR(64)  NULL                                  COMMENT 'attempt_id / pin_issue_command.id / refund_attempt.id',
  `op`                 VARCHAR(24)  NULL                                  COMMENT '응답을 유발한 operation',
  `owner_token`        VARCHAR(64)  NULL                                  COMMENT '응답 소유자 토큰(불일치 근거)',
  `generation`         BIGINT       NULL,
  `workflow_version`   BIGINT       NULL,
  `mismatch_reason`    VARCHAR(32)  NOT NULL                              COMMENT 'OWNER_TOKEN|GENERATION|WORKFLOW_VERSION|HEARTBEAT_ERROR|MULTIPLE',
  `response_body_enc`  MEDIUMTEXT   NOT NULL                              COMMENT '원본 응답 암호문(§8.3 암호화 저장)',
  `created_at`         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_stale_external_response_target` (`state_machine`, `target_key`),
  KEY `idx_stale_external_response_delivery` (`order_delivery_id`, `created_at`),
  KEY `idx_stale_external_response_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='fencing 불일치(stale) 외부 응답 감사 보관';

-- M8 검증
-- 보존·파기(§8.3 제안 90일): 별도 배치에서 created_at < NOW() - INTERVAL 90 DAY 파기.
-- M8 롤백: DROP TABLE IF EXISTS `stale_external_response`;


-- ============================================================================
-- 전체 롤백 순서 (코드 롤백 후에만)
--   DROP TABLE IF EXISTS `stale_external_response`;
--   DROP TABLE IF EXISTS `workflow_resolution`;
--   DROP TABLE IF EXISTS `dual_approval_audit`;
--   DROP TABLE IF EXISTS `dual_approval`;
--   DROP TABLE IF EXISTS `refund_attempt`;
--   DROP TABLE IF EXISTS `message_attempt`;
--   DROP TABLE IF EXISTS `pin_issue_command`;
--   DROP TABLE IF EXISTS `delivery_workflow`;
-- ============================================================================
