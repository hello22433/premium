-- ops_20260723_financial_pii_preaudit.sql
--
-- 금융 PII(계좌/카드번호) 대칭키 암호화 전환의 사전 감사(READ-ONLY) 쿼리.
-- 실행 주체: 운영/DBA (에이전트는 DB 미접근). 결과는 아래 판정에 사용.
-- 관련 계획: .gjc .../ralplan/.../pending-approval.md (Option A: 기존 DELIVERY_TARGET_CRYPTO_KEY 재사용 + 결정론 고정IV, 전량 백필)
--
-- 이 파일은 DDL 변경이 없다(SELECT 전용). 결과를 근거로:
--   (1) user_company 금융컬럼 백필 포함/제외 판정
--   (2) varchar(100) 컬럼 폭 여유(암호문 base64 수용) 판정 → 초과 시 widening ALTER 필요

-- ─────────────────────────────────────────────────────────────
-- [게이트 1] user_company at-rest COUNT — 활성 reader/writer는 없으나 저장된 평문 잔존 여부 실측
--   COUNT > 0  → user_company.bankNumber/cardNumber 를 백필 대상에 포함(또는 명시적 purge 결정 기록)
--   COUNT = 0  → 제외 근거로 이 결과를 보관(Recorded Negatives)
-- ─────────────────────────────────────────────────────────────
SELECT
  COUNT(*)                                                             AS user_company_pii_rows,
  SUM(CASE WHEN bankNumber IS NOT NULL AND bankNumber <> '' THEN 1 ELSE 0 END) AS bankNumber_nonempty,
  SUM(CASE WHEN cardNumber IS NOT NULL AND cardNumber <> '' THEN 1 ELSE 0 END) AS cardNumber_nonempty
FROM user_company
WHERE (bankNumber IS NOT NULL AND bankNumber <> '')
   OR (cardNumber IS NOT NULL AND cardNumber <> '');

-- ─────────────────────────────────────────────────────────────
-- [게이트 2] 길이 pre-audit — varchar(100) 컬럼(user.bankNumber/cardNumber, partner_company.bankNumber)
--   암호문 예상 길이(AES-256-CBC → base64): 평문 n바이트 → ceil((n+1)/16)*16 → base64 ×4/3.
--   예) 계좌 14자 → 16B → base64 24자 / 카드 16자 → 32B → base64 44자. varchar(100) 여유 충분이 정상.
--   MAX 결과가 커서 암호화 후 100자 초과 위험(평문 ~66자 초과)이면 widening ALTER 필요.
-- ─────────────────────────────────────────────────────────────
SELECT
  MAX(CHAR_LENGTH(bankNumber)) AS user_bankNumber_max_len,
  MAX(CHAR_LENGTH(cardNumber)) AS user_cardNumber_max_len
FROM `user`;

SELECT
  MAX(CHAR_LENGTH(bankNumber)) AS partner_company_bankNumber_max_len
FROM partner_company;

-- order_delivery.bankAccount 는 varchar(255) 이므로 길이 안전(pre-audit 불필요, 참고용).
SELECT
  MAX(CHAR_LENGTH(bankAccount)) AS order_delivery_bankAccount_max_len
FROM order_delivery;

-- ─────────────────────────────────────────────────────────────
-- 판정 기록 템플릿(운영이 결과를 여기에 남기고 백필 스크립트 실행 여부/범위를 확정):
--   user_company_pii_rows      = ____   → (포함 | 제외)
--   user_bankNumber_max_len    = ____   → (여유 OK | widening 필요)
--   user_cardNumber_max_len    = ____   → (여유 OK | widening 필요)
--   partner_bankNumber_max_len = ____   → (여유 OK | widening 필요)
-- ─────────────────────────────────────────────────────────────
