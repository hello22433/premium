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

-- ⚠️ 일부러 `IF NOT EXISTS` 를 쓰지 않는다.
--    구 설계의 `bank_deposit`(erp_macro 가 직접 write 하던 것)이 남아 있는데 이 스크립트가
--    조용히 성공해 버리면, 앱은 스키마가 다른 테이블을 상대로 돌고(컬럼 불일치), 게다가 그
--    테이블에 행이 남아 있으면 미러가 "이미 차 있다"고 오판해 백필이 어긋난다.
--    이미 있으면 여기서 오류로 멈추는 것이 맞다 — 위 정리 절차를 먼저 수행하라는 신호다.
CREATE TABLE `bank_deposit` (
  `id`                INT          NOT NULL AUTO_INCREMENT,

  -- ===== 원본 미러 (erp_macro 정본) =====
  `dedup_key`         VARCHAR(64)  NOT NULL COMMENT '[원본] erp_macro 지문 = SHA-256(계좌|일자|구분|금액|잔액|입금처). 멱등 upsert 키',
  `tx_date`           DATE         NOT NULL COMMENT '[원본] ECOUNT 일자. DATE 라 시각 없음(하루 밀림 방지)',
  `tx_type`           VARCHAR(10)  NOT NULL COMMENT '[원본] ECOUNT 구분 원문: 입금/출금',
  `account_no`        VARCHAR(50)  NOT NULL COMMENT '[원본] 계좌번호(마스킹형). 계좌 식별은 이 컬럼으로',
  `account_name`      VARCHAR(100) NULL     COMMENT '[원본] ECOUNT 계좌명. 은행명/회사명/용도가 섞여 있어 식별자로 쓰지 말 것',
  -- PII 4종. erp_macro 가 자기 DB 에 암호화 저장하는 값이라 미러도 같은 수준으로 보관한다.
  -- 저장 스킴 = encryptDeliveryTarget(AES-256-CBC, 고정 IV → 결정론적). 평문보다 길어지므로 512.
  -- 결정론적이라 같은 평문은 항상 같은 암호문이며, 그 덕에 DISTINCT/전체일치 조회가 성립한다.
  `erp_partner_code`  VARCHAR(512) NULL     COMMENT '[원본][암호화] ECOUNT 거래처코드',
  `erp_partner_name`  VARCHAR(512) NULL     COMMENT '[원본][암호화] ECOUNT 거래처명',
  -- ⚠️ NULL 허용이어야 한다. ECOUNT 출입금 원장에는 입금처가 비는 행이 있다(수수료·자동이체 등
  --    출금 계열). NOT NULL 로 두면 그런 행 **한 개**가 500행짜리 multi-row INSERT 전체를 되돌리고,
  --    백필이 매 주기 같은 자리에서 죽어 미러가 영원히 수렴하지 못한다(에러는 "일시 실패"로 보고된다).
  --    빈 문자열은 암호화하지 않고 NULL 로 저장한다 — 결정론적 스킴에서 "빈값"이 특정 암호문으로
  --    고정되면 그 자체가 식별 정보가 된다.
  `depositor`         VARCHAR(512) NULL     COMMENT '[원본][암호화] 입금처 - (가상) 접두 제거본. 원본에 없으면 NULL',
  `depositor_raw`     VARCHAR(512) NULL     COMMENT '[원본][암호화] 입금처 원문',
  `amount`            BIGINT       NOT NULL COMMENT '[원본] 금액(원). INT 상한을 넘을 수 있어 BIGINT',
  `balance`           BIGINT       NOT NULL COMMENT '[원본] 거래후 잔액(원)',
  `voucher_no`        VARCHAR(50)  NULL     COMMENT '[원본] 회계전표번호. 숫자가 아닐 수 있음(강제회계반영 등) — 파싱 금지',

  -- ===== 프리미엄 소유 (동기화가 덮지 않는다) =====
  -- 귀속 대상은 고객(user)이 아니라 **예치금 지갑의 주인**이다. 지갑(wallet_account)은 주인을
  -- (owner_type, owner_id) **쌍**으로 표현하므로, 이 미러도 같은 쌍을 그대로 복사한다.
  --   · 현재 유효한 타입은 'SETTLEMENT_CODE' 하나뿐이고, 그때 owner_id = user.settlement_code 다.
  --   · 타입이 하나뿐인데도 컬럼을 함께 두는 이유: 지갑 주인 단위 확장이 예정되어 있고,
  --     id 만 저장하면 확장 시점에 기존 행이 어느 타입이었는지 **사후 판별이 불가능**하다.
  --     (지금 채워두면 확장 시 이 테이블은 손댈 필요가 없다)
  -- user 로 잡지 않는 이유: 정산코드 하나를 여러 user 가 공유하므로 어느 user 를 골라도 돈은
  -- 같은 지갑으로 가는 의미 없는 자유도가 생기고, settlement_code 가 없는 user 에 매칭하면
  -- 매칭은 통과하고 충전 단계에서 실패하는 지연 실패가 된다.
  `matched_owner_type` VARCHAR(20) NULL COMMENT '[프리미엄] wallet_account.owner_type. 현재 SETTLEMENT_CODE 단일. 미매핑이면 NULL',
  `matched_owner_id`   VARCHAR(50) NULL COMMENT '[프리미엄] wallet_account.owner_id(SETTLEMENT_CODE 면 user.settlement_code). FK 제약 없는 논리 참조',
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
  -- 암호문 인덱스. 부분검색(LIKE)에는 못 쓰지만, 결정론적 암호화라 DISTINCT 로 고유 입금처를
  -- 뽑고 전체일치(IN)로 되짚는 검색 경로가 이 인덱스를 탄다. 길이 제한상 접두 191바이트만.
  KEY `idx_bank_deposit_depositor` (`depositor`(191)),
  KEY `idx_bank_deposit_match_status` (`match_status`),
  KEY `idx_bank_deposit_account_no` (`account_no`),
  -- 다형 참조(타입+id 쌍)의 전형적 결함인 "한쪽만 채워진 행"을 DB 에서 차단한다.
  -- 매칭은 언제나 (타입, id) 가 함께 정해지는 사건이고, 한쪽만 있는 행은 표시명 조회에서
  -- 조용히 null 이 되어 미매칭처럼 보인다. wallet_account 의 chk_wallet_owner_type 과 같은 관례.
  CONSTRAINT `chk_bank_deposit_matched_owner` CHECK (
    (`matched_owner_type` IS NULL AND `matched_owner_id` IS NULL)
    OR (`matched_owner_type` IS NOT NULL AND `matched_owner_id` IS NOT NULL)
  )
  -- (matched_owner_type, matched_owner_id) 인덱스는 일부러 만들지 않는다. 지금은 이 컬럼으로
  -- 거르는 조회 경로가 없고, 5분 주기 upsert 가 도는 테이블이라 안 쓰는 인덱스는 쓰기 비용만
  -- 남는다. "이 주인으로 매칭된 입금 목록" 화면이 생길 때 함께 추가하면 된다.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='ECOUNT 입출금 거래내역 미러(erp_macro API 로 동기화)';


-- 검증 쿼리
-- SHOW CREATE TABLE `bank_deposit`;
-- SELECT COUNT(*) FROM `bank_deposit`;
-- SELECT match_status, COUNT(*) FROM `bank_deposit` GROUP BY match_status;
