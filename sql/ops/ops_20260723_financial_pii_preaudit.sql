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
--   예) 계좌 14자 → 16B → base64 24자 / 카드 16자 → 32B → base64 44자. varchar(100) 여유 충분이 정상.
--   MAX 결과가 커서 암호화 후 100자 초과 위험(평문 ~66자 초과)이면 widening ALTER 필요.
-- ─────────────────────────────────────────────────────────────
SELECT
  MAX(CHAR_LENGTH(bank_number)) AS user_bank_number_max_len,
  MAX(CHAR_LENGTH(card_number)) AS user_card_number_max_len
FROM `user`;

SELECT
  MAX(CHAR_LENGTH(bank_number)) AS partner_company_bank_number_max_len
FROM partner_company;

-- order_delivery.bank_account 는 varchar(255) 이므로 길이 안전(pre-audit 불필요, 참고용).
SELECT
  MAX(CHAR_LENGTH(bank_account)) AS order_delivery_bank_account_max_len
FROM order_delivery;

-- ─────────────────────────────────────────────────────────────
-- 판정 기록 템플릿(운영이 결과를 여기에 남기고 백필 스크립트 실행 여부/범위를 확정):
--   user_company_pii_rows        = ____   → (포함 | 제외)
--   user_bank_number_max_len     = ____   → (여유 OK | widening 필요)
--   user_card_number_max_len     = ____   → (여유 OK | widening 필요)
--   partner_bank_number_max_len  = ____   → (여유 OK | widening 필요)
-- ─────────────────────────────────────────────────────────────
