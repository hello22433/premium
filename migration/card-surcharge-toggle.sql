-- 정산코드 카드할증(3%) 토글 컬럼 추가 (멱등)
-- 실행 시점: feature/card-surcharge-toggle 배포 전(백엔드 엔티티 배포와 함께).
-- 목적: wallet_account 에 카드할증 기본값(card_surcharge_applied) 신설.
--   유효 카드할증 = settleMethod='CARD' && card_surcharge_applied (default 파생에만 CARD 게이트).
-- behavior-preserving: 전 행 DEFAULT 1. CARD 게이트 덕분에 CASH 코드는 컬럼이 1이어도 기본값 false(현행과 동일).
--   CARD 코드는 기본 할증 ON(현행 CARD⇒할증 ON과 동일). 주문별 order.cardSurchargeApplied 는 박제라 과거 주문 무영향.

-- ── ADD COLUMN (이미 있으면 no-op) ──
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'wallet_account'
    AND COLUMN_NAME = 'card_surcharge_applied'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE wallet_account
     ADD COLUMN card_surcharge_applied TINYINT(1) NOT NULL DEFAULT 1
     COMMENT ''카드할증 3% 적용 기본값 (settleMethod=CARD 코드 기준)'' AFTER settle_method',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 검증: 컬럼 존재 및 분포 확인 ──
SELECT
  settle_method,
  card_surcharge_applied,
  COUNT(*) AS cnt
FROM wallet_account
GROUP BY settle_method, card_surcharge_applied
ORDER BY settle_method, card_surcharge_applied;
