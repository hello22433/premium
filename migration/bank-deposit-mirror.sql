-- 입금내역 미러 테이블 (프리미엄 소유)
--
-- 실행 시점: 코드 배포 **전**. 테이블이 없으면 조회 화면이 첫 요청부터 500 이다.
--
-- 배경: 설계가 "공유 DB" 에서 "erp_macro API pull" 로 바뀌었다.
--   · erp_macro = ECOUNT 를 긁어 자기 DB 에 raw 저장 + 조회 API 노출
--   · premium   = 그 API 를 5분마다 호출해 이 테이블에 미러링, 화면은 이 테이블을 읽음
--   따라서 이 테이블의 소유자는 **프리미엄**이다(예전의 erp_macro 소유 테이블과 다르다).
--   API 계약: docs/API계약-erp_macro-입금내역-조회.md
--
-- ⚠️ 옛 설계의 잔재 정리
--   개발 DB 에는 erp_macro 가 직접 write 하던 `bank_deposit`(+`depositor_mapping`,
--   `deposit_polling_gate`)이 이미 있을 수 있다. 그 데이터의 정본은 이제 erp_macro 쪽 DB 이므로,
--   **erp_macro DB 로 옮긴 것을 확인한 뒤** 아래 순서로 정리한다.
--     1) 백업:  mysqldump ... epopkon bank_deposit depositor_mapping deposit_polling_gate > backup.sql
--     2) DROP TABLE `bank_deposit`, `depositor_mapping`, `deposit_polling_gate`;
--     3) 이 스크립트 실행
--   미러는 비어 있어도 무방하다 — 동기화 배치가 최초 1회 전체 백필로 다시 채운다.
--
-- 컬럼 소유권이 두 갈래로 나뉜다. 이게 이 테이블의 핵심 규칙이다.
--   [원본 미러] erp_macro API 가 정본. 동기화가 매 주기 덮어쓴다.
--   [프리미엄]  프리미엄만 쓴다. **동기화는 이 컬럼들을 절대 건드리지 않는다.**
--   동기화 upsert 가 전체 컬럼을 덮으면, 운영자가 방금 지정한 매칭이 다음 주기에
--   조용히 UNMATCHED 로 되돌아간다. 그래서 upsert 의 갱신 컬럼 목록을 코드에서
--   명시적으로 열거한다(deposit.sync.service.ts).

CREATE TABLE IF NOT EXISTS `bank_deposit` (
  `id`                INT          NOT NULL AUTO_INCREMENT,

  -- ===== 원본 미러 (erp_macro 정본) =====
  `dedup_key`         VARCHAR(64)  NOT NULL COMMENT '[원본] erp_macro 지문 = SHA-256(계좌|일자|구분|금액|잔액|입금처). 멱등 upsert 키',
  `tx_date`           DATE         NOT NULL COMMENT '[원본] ECOUNT 일자. DATE 라 시각 없음(하루 밀림 방지)',
  `tx_type`           VARCHAR(10)  NOT NULL COMMENT '[원본] ECOUNT 구분 원문: 입금/출금',
  `account_no`        VARCHAR(50)  NOT NULL COMMENT '[원본] 계좌번호(마스킹형). 계좌 식별은 이 컬럼으로',
  `account_name`      VARCHAR(100) NULL     COMMENT '[원본] ECOUNT 계좌명. 은행명/회사명/용도가 섞여 있어 식별자로 쓰지 말 것',
  `erp_partner_code`  VARCHAR(50)  NULL     COMMENT '[원본] ECOUNT 거래처코드',
  `erp_partner_name`  VARCHAR(191) NULL     COMMENT '[원본] ECOUNT 거래처명',
  `depositor`         VARCHAR(191) NOT NULL COMMENT '[원본] 입금처 - (가상) 접두 제거본',
  `depositor_raw`     VARCHAR(191) NULL     COMMENT '[원본] 입금처 원문',
  `amount`            BIGINT       NOT NULL COMMENT '[원본] 금액(원). INT 상한을 넘을 수 있어 BIGINT',
  `balance`           BIGINT       NOT NULL COMMENT '[원본] 거래후 잔액(원)',
  `voucher_no`        VARCHAR(50)  NULL     COMMENT '[원본] 회계전표번호. 숫자가 아닐 수 있음(강제회계반영 등) — 파싱 금지',

  -- ===== 프리미엄 소유 (동기화가 덮지 않는다) =====
  `matched_user_id`   INT          NULL     COMMENT '[프리미엄] FK) user.id. 매핑으로 연결된 고객(미매핑이면 NULL). FK 제약 없는 논리 참조',
  `match_status`      VARCHAR(20)  NOT NULL DEFAULT 'UNMATCHED' COMMENT '[프리미엄] UNMATCHED/MAPPED/AMBIGUOUS/CREDITED',

  -- ===== 동기화 메타 =====
  -- 상대 API 의 scrapedAt 은 "처음 목격한 시각"이며 재스크래핑으로 갱신되지 않는다.
  -- "원본이 마지막으로 바뀐 시각"에 해당하는 신호는 현재 API 에 없다.
  `source_scraped_at` DATETIME(6)  NOT NULL COMMENT '[원본] erp_macro 가 이 거래를 처음 목격한 시각',
  `synced_at`         DATETIME(6)  NOT NULL COMMENT '[프리미엄] 이 행을 마지막으로 받아온 시각',

  `created_at`        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  -- 멱등 upsert 의 충돌 대상. 이게 UNIQUE 여야 ON DUPLICATE KEY UPDATE 가 성립한다.
  UNIQUE KEY `uk_bank_deposit_dedup` (`dedup_key`),
  -- 목록 기본 정렬/필터가 (tx_date DESC, id DESC) 라 tx_date 선두 인덱스가 정렬을 돕는다.
  KEY `idx_bank_deposit_tx_date` (`tx_date`),
  KEY `idx_bank_deposit_depositor` (`depositor`),
  KEY `idx_bank_deposit_match_status` (`match_status`),
  KEY `idx_bank_deposit_account_no` (`account_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='ECOUNT 입출금 거래내역 미러(erp_macro API 로 동기화)';


-- 검증 쿼리
-- SHOW CREATE TABLE `bank_deposit`;
-- SELECT COUNT(*) FROM `bank_deposit`;
-- SELECT match_status, COUNT(*) FROM `bank_deposit` GROUP BY match_status;
