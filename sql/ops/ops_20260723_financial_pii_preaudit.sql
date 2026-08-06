-- ops_20260723_financial_pii_preaudit.sql
--
-- 금융 PII(계좌/카드번호) 대칭키 암호화 전환의 사전 감사(READ-ONLY) 쿼리.
-- 실행 주체: 운영/DBA (에이전트는 DB 미접근). 결과는 아래 판정에 사용.
-- 관련 계획: .gjc .../ralplan/.../pending-approval.md (Option A: 기존 DELIVERY_TARGET_CRYPTO_KEY 재사용 + 결정론 고정IV, 전량 백필)
--
-- ⚠ 컬럼명: 이 프로젝트는 TypeORM SnakeNamingStrategy 를 사용한다(database.module.ts).
--   엔티티 속성 bankNumber/cardNumber/bankAccount 의 물리 컬럼은 bank_number/card_number/bank_account 이다.
--
-- 이 파일은 DDL 변경이 없다(SELECT 전용). 결과를 근거로:
--   (1) user_company 금융컬럼 백필 포함/제외 판정
--   (2) varchar(100) 컬럼 폭 여유(암호문 base64 수용) 판정 → 초과 시 widening ALTER 필요

-- ─────────────────────────────────────────────────────────────
-- [게이트 1] user_company at-rest COUNT — 활성 reader/writer는 없으나 저장된 평문 잔존 여부 실측
--   COUNT > 0  → user_company.bank_number/card_number 를 백필 대상에 포함(또는 명시적 purge 결정 기록)
--   COUNT = 0  → 제외 근거로 이 결과를 보관(Recorded Negatives)
-- ─────────────────────────────────────────────────────────────
SELECT
  COUNT(*)                                                                          AS user_company_pii_rows,
  SUM(CASE WHEN bank_number IS NOT NULL AND bank_number <> '' THEN 1 ELSE 0 END)    AS bank_number_nonempty,
  SUM(CASE WHEN card_number IS NOT NULL AND card_number <> '' THEN 1 ELSE 0 END)    AS card_number_nonempty
FROM user_company
WHERE (bank_number IS NOT NULL AND bank_number <> '')
   OR (card_number IS NOT NULL AND card_number <> '');

-- ─────────────────────────────────────────────────────────────
-- [게이트 2] 길이 pre-audit — varchar(100) 컬럼(user.bank_number/card_number, partner_company.bank_number)
--   암호문 예상 길이(AES-256-CBC → base64): 평문 n바이트 → ceil((n+1)/16)*16 → base64 ×4/3.
--   예) 계좌 14B → 16B → base64 24자 / 카드 16B → 32B → base64 44자. varchar(100) 여유 충분이 정상.
--   varchar(100) 상한 역산: padded ≤ 64B → **평문 ≤ 63바이트**. 초과면 widening ALTER 필요.
--
--   ⚠ 반드시 LENGTH(바이트)로 잰다. CHAR_LENGTH(문자수)는 잘못된 자다 — 암호문 길이는 평문의 바이트
--     수로 결정되므로, 값에 한글이 섞이면 24자가 최대 72B(→ base64 108자)가 되어 varchar(100)을 넘긴다.
--     CHAR_LENGTH 는 두 값이 갈리는지(= 멀티바이트 혼입 여부) 보려고 함께 조회한다.
-- ─────────────────────────────────────────────────────────────
SELECT
  MAX(LENGTH(bank_number))      AS user_bank_number_max_bytes,
  MAX(LENGTH(card_number))      AS user_card_number_max_bytes,
  MAX(CHAR_LENGTH(bank_number)) AS user_bank_number_max_chars,
  MAX(CHAR_LENGTH(card_number)) AS user_card_number_max_chars
FROM `user`;

SELECT
  MAX(LENGTH(bank_number))      AS partner_company_bank_number_max_bytes,
  MAX(CHAR_LENGTH(bank_number)) AS partner_company_bank_number_max_chars
FROM partner_company;

-- 게이트 1은 COUNT 만 재므로 폭을 모른다. 백필 대상으로 확정되면(COUNT>0) 여기도 재야 한다.
SELECT
  MAX(LENGTH(bank_number)) AS user_company_bank_number_max_bytes,
  MAX(LENGTH(card_number)) AS user_company_card_number_max_bytes
FROM user_company;

-- order_delivery.bank_account 는 varchar(255) 이므로 길이 안전(pre-audit 불필요, 참고용).
SELECT
  MAX(LENGTH(bank_account)) AS order_delivery_bank_account_max_bytes
FROM order_delivery;

-- ─────────────────────────────────────────────────────────────
-- [게이트 4] 값 형태 분류 — 백필 스크립트의 dedup 판정을 SQL 로 미리 검산한다.
--   대상 6개 컬럼 **전부에 같은 분류 축**을 적용한다. 컬럼마다 다른 축(예: 숫자/비숫자 2분류)을 쓰면
--   "숫자가 아닌 값"이 한 덩어리로 뭉쳐 검수 대상이 사라진다.
--
--   분류 축:
--     destroy_tombstone     '-' 파기 sentinel. 절대 건드리지 않는다(스크립트 DESTROY_VALUE skip).
--     plaintext_digit       숫자/공백/하이픈. 정상 계좌·카드번호 형태 → 백필 대상.
--     ciphertext_b64_shape  base64 **형태상 후보**. 형태가 맞을 뿐 복호화 성공을 증명하지 않는다.
--                           실제 판정은 스크립트의 복호화 시도가 하며, 이 값은 눈대중 참고용이다.
--     OTHER_MUST_INSPECT    위 어디에도 안 드는 값. 아래 두 번째 쿼리로 PK 를 뽑아 눈으로 확인하기
--                           전에는 백필하지 말 것.
--
--   ⚠ SQL 분류 ≠ 스크립트 판정. 스크립트(migration/encrypt-financial-pii-backfill.ts)는
--     "복호화 시도 → throw 면 평문" 으로 판별하므로, **OTHER_MUST_INSPECT 값도 대개 평문으로 분류돼
--     암호화된다**(개발DB partner_company 의 리터럴 "string" 6건이 그 사례). 즉 이 게이트에서
--     OTHER_MUST_INSPECT 를 방치하면 의도치 않은 값이 조용히 암호화된다. 반드시 먼저 검수한다.
-- ─────────────────────────────────────────────────────────────
WITH pii_values AS (
  SELECT 'user.bank_number'            AS col, id, bank_number  AS val FROM `user`           WHERE bank_number  IS NOT NULL AND bank_number  <> ''
  UNION ALL
  SELECT 'user.card_number',                 id, card_number         FROM `user`           WHERE card_number  IS NOT NULL AND card_number  <> ''
  UNION ALL
  SELECT 'user_company.bank_number',         id, bank_number         FROM user_company     WHERE bank_number  IS NOT NULL AND bank_number  <> ''
  UNION ALL
  SELECT 'user_company.card_number',         id, card_number         FROM user_company     WHERE card_number  IS NOT NULL AND card_number  <> ''
  UNION ALL
  SELECT 'partner_company.bank_number',      id, bank_number         FROM partner_company  WHERE bank_number  IS NOT NULL AND bank_number  <> ''
  UNION ALL
  SELECT 'order_delivery.bank_account',      id, bank_account        FROM order_delivery   WHERE bank_account IS NOT NULL AND bank_account <> ''
)
SELECT
  col,
  CASE
    WHEN val = '-'                                 THEN 'destroy_tombstone'
    WHEN val REGEXP '^[0-9][0-9 -]*$'              THEN 'plaintext_digit'
    WHEN val REGEXP '^[A-Za-z0-9+/]{24,}={0,2}$'   THEN 'ciphertext_b64_shape'
    ELSE 'OTHER_MUST_INSPECT'
  END AS shape,
  COUNT(*)         AS cnt,
  MAX(LENGTH(val)) AS max_bytes
FROM pii_values
GROUP BY 1, 2
ORDER BY 1, 2;

-- 검수 대상 전수 = OTHER_MUST_INSPECT **+ ciphertext_b64_shape**. 값은 마스킹해서 뽑는다
-- (PII 가 콘솔/로그로 새지 않도록). 즉 "평문 형태도 파기 sentinel 도 아닌" 모든 값을 훑는다.
--
-- ciphertext_b64_shape 를 함께 뽑는 이유 — 여기가 가장 위험한 칸이다:
--   base64 정규식은 **형태**만 본다. 형태가 맞아도 실제 복호화는 실패할 수 있다(다른 키로 암호화된
--   값, 잘린 값, 우연히 base64 꼴인 평문 등). 그런 값을 스크립트는 "복호화 throw → 평문" 으로
--   판정해 **한 번 더 암호화**한다. 그러면 앱의 일반 단일 복호화 경로(safeDecryptAccountNumber)로는
--   원문이 나오지 않고 계좌번호 자리에 base64 문자열이 그대로 노출된다 — 운영 장애다.
--   데이터가 소실되는 것은 아니지만, 복구 경로는 원래 값이 무엇이었냐에 따라 갈린다:
--     · 원래 암호문이 **현재 키로** 암호화된 값이면 → 두 번 복호해 원값을 얻는다.
--     · 다른 키로 암호화된 값·손상된 값이면 → 두 번째 복호도 실패한다. 백업 스냅샷으로 되돌린다.
--   어느 쪽이든 수작업이므로 애초에 만들지 않는 편이 낫다.
--   반대로 정상 암호문이면 스크립트가 skip 하므로, 이 목록의 행은 "skip 될 것" 이라는 예상과
--   dry-run 결과가 일치하는지 대조하는 근거가 된다.
--
-- 여기 나온 행은 백필 전에 개별 검수한다. 계좌번호가 아닌 값(더미·오입력)이면 백필 대상에서
-- 빼거나 데이터를 먼저 정리한다.
WITH pii_values AS (
  SELECT 'user.bank_number'            AS col, id, bank_number  AS val FROM `user`           WHERE bank_number  IS NOT NULL AND bank_number  <> ''
  UNION ALL
  SELECT 'user.card_number',                 id, card_number         FROM `user`           WHERE card_number  IS NOT NULL AND card_number  <> ''
  UNION ALL
  SELECT 'user_company.bank_number',         id, bank_number         FROM user_company     WHERE bank_number  IS NOT NULL AND bank_number  <> ''
  UNION ALL
  SELECT 'user_company.card_number',         id, card_number         FROM user_company     WHERE card_number  IS NOT NULL AND card_number  <> ''
  UNION ALL
  SELECT 'partner_company.bank_number',      id, bank_number         FROM partner_company  WHERE bank_number  IS NOT NULL AND bank_number  <> ''
  UNION ALL
  SELECT 'order_delivery.bank_account',      id, bank_account        FROM order_delivery   WHERE bank_account IS NOT NULL AND bank_account <> ''
)
SELECT
  col, id,
  CASE
    WHEN val REGEXP '^[A-Za-z0-9+/]{24,}={0,2}$' THEN 'ciphertext_b64_shape'
    ELSE 'OTHER_MUST_INSPECT'
  END AS shape,
  LENGTH(val)      AS bytes,
  CHAR_LENGTH(val) AS chars,
  CONCAT(LEFT(val, 2), '****', RIGHT(val, 2)) AS masked
FROM pii_values
WHERE val <> '-'
  AND val NOT REGEXP '^[0-9][0-9 -]*$'
ORDER BY shape, col, id;

-- ─────────────────────────────────────────────────────────────
-- [게이트 5] updated_at 자동 갱신 여부 — 백필이 업무상 최종수정시각을 흔드는지 판정.
--   EXTRA 에 'on update CURRENT_TIMESTAMP' 가 있으면, 저장 형식만 바꾸는 백필 UPDATE 가
--   updated_at 을 현재 시각으로 밀어버린다. 그 경우 백필 UPDATE 에 `updated_at = updated_at` 을
--   함께 SET 해서 자동 갱신을 막아야 한다.
-- ─────────────────────────────────────────────────────────────
SELECT TABLE_NAME, COLUMN_NAME, EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND COLUMN_NAME = 'updated_at'
  AND TABLE_NAME IN ('user', 'user_company', 'partner_company', 'order_delivery');

-- ─────────────────────────────────────────────────────────────
-- 판정 기록 (2026-08-03 실측, **개발 DB**)
--   실행 환경 근거: partner_company 에 id=0 행과 리터럴 "string" 6건(시드 더미)이 존재.
--   ⚠ 상용은 데이터 분포가 다르므로 백필 전에 이 파일을 상용에서 다시 실행하고 아래를 새로 기록할 것.
--
--   user_company_pii_rows              = 4 (bank 4 / card 4)  → **포함** (dead 가정 기각)
--   user_bank_number_max_bytes         = 24  → 여유 OK (암호문 44자 / 100)
--   user_card_number_max_bytes         = 8   → 여유 OK (암호문 24자 / 100)
--   partner_bank_number_max_bytes      = 10  → 여유 OK (암호문 24자 / 100)
--   user_company_bank_number_max_bytes = 4   → 여유 OK (암호문 24자 / 100)
--   user_company_card_number_max_bytes = 8   → 여유 OK (암호문 24자 / 100)
--   order_delivery_bank_account_bytes  = 14  → 여유 OK (암호문 24자 / 255)
--   ⇒ **widening ALTER 불필요** — 20260723_encrypt_financial_pii_columns.sql 은 no-op DDL 로 확정.
--      (LENGTH == CHAR_LENGTH 로 전 컬럼 ASCII 확인. 멀티바이트 혼입 없음.)
--
--   [게이트 4] 값 형태
--     ⚠ 측정 당시엔 order_delivery 만 4분류였고 나머지 컬럼은 숫자/비숫자 2분류로 쟀다. 아래는 그
--       결과를 4분류 축으로 재해석한 값이다. 갱신된 게이트4 쿼리로 재실행해 검산할 것.
--     order_delivery.bank_account : plaintext_digit 49 / destroy_tombstone 41,394 / 그 외 0
--     user.bank_number            : plaintext_digit 62 / ciphertext_b64_shape 2 (id 32·81, `/`·`==` 확인)
--     user.card_number            : plaintext_digit 9
--     user_company.bank_number    : plaintext_digit 4
--     user_company.card_number    : plaintext_digit 4
--     partner_company.bank_number : plaintext_digit 2  / OTHER_MUST_INSPECT 6 (리터럴 "string" 시드 더미)
--
--   ⇒ 백필 실행 시 **예상 updated = 136행** (--include-user-company 기준)
--       내역 = plaintext_digit 130 + partner_company "string" 6
--       "string" 6건이 더해지는 이유: 스크립트의 판정은 SQL 정규식이 아니라 **복호화 시도**다
--       (classify(): 복호화 throw → 평문 확정 → 암호화). base64 로 해석해도 블록 길이가 안 맞아
--       throw 하므로 평문으로 분류되어 암호화된다. 복호하면 "string" 그대로 돌아와 무해하지만,
--       **dry-run 의 updated 를 130 으로 기대하면 오탐(장애 판정)이 난다.**
--       "string" 을 굳이 제외하려면 데이터를 먼저 정리하거나 스크립트에 숫자형 화이트리스트를
--       추가해야 한다 — 현재는 제외하지 않는 쪽으로 둔다(무해 + 스크립트 단순성 유지).
--   ⇒ 예상 skipped = 41,396행 (destroy_tombstone 41,394 + 암호문 형태 2)
--   ⇒ 예상 ambiguous = 0. 1건이라도 나오면 그 행을 검수하기 전에는 진행하지 말 것.
--
--   ── dry-run tripwire (반드시 대조할 것) ──
--     user.bank_number id 32·81 은 base64 **형태**만 확인했다. 실제로 복호화가 되는지는 검증하지
--     않았다. 형태가 맞아도 복호화가 실패하면 스크립트는 그 값을 평문으로 판정해 한 번 더
--     암호화하고, 그러면 앱의 단일 복호화 경로로는 원문이 안 나온다. 복구는 원래 값이 현재 키
--     암호문이면 2회 복호로, 다른 키·손상 값이면 백업 스냅샷으로 — 어느 쪽이든 수작업이다.
--       · dry-run updated = 136  → 정상. 두 행이 skip 됐다는 뜻.
--       · dry-run updated > 136  → **즉시 중단.** 암호문으로 봤던 행이 평문 판정을 받았다는 뜻이다.
--         그대로 실행하면 그 행이 이중 암호화되어 수작업 복구가 필요해진다.
--       · ambiguous > 0          → 중단하고 해당 행 개별 검수.
--
--   [게이트 5] updated_at ON UPDATE 자동 갱신 = **4개 테이블 전부 해당**
--     user / user_company / partner_company / order_delivery 모두
--     EXTRA = 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)'
--   ⇒ 백필 UPDATE 에 `updated_at = updated_at` 필수. 반영 완료(encrypt-financial-pii-backfill.ts).
--
-- ── 백필 실행 시 주의 (migration/encrypt-financial-pii-backfill.ts) ──
--   · user_company 가 대상으로 확정됐으므로 **--include-user-company 필수**. 기본값 off 로 돌리면
--     평문 4행이 그대로 남는다.
--   · order_delivery 의 '-' 41,394행은 절대 암호화하지 않는다. 암호화되면 값이 '-' 가 아니게 되어
--     정기파기 배치의 재수집 술어(delivery.batch.service.ts, PII 5종 중 하나라도 != '-')에 다시 걸려
--     파기 완료 건이 매 회차 재처리 대상으로 부활한다. 스크립트의 DESTROY_VALUE skip 이 이를 막는다.
-- ─────────────────────────────────────────────────────────────
