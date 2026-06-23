-- order 테이블에 settle_method(결제수단) 영속 컬럼 추가.
-- cardSurchargeApplied 와 독립 저장 (강제 결합 제거). 정산입력 완료 표식 = settle_method IS NOT NULL.

-- (1) 컬럼 추가 (NULL 허용; 신규 저장은 항상 non-null, NULL 은 미입력/레거시 미백필)
ALTER TABLE `order`
  ADD COLUMN `settle_method` ENUM('CARD','CASH') NULL
  COMMENT '결제수단 (CARD/CASH). 정산입력 완료 표식. NULL=미입력/레거시'
  AFTER `card_surcharge_applied`;

-- (2) 백필 — 기존 정산입력(settle_amount>0) row 는 card_surcharge_applied 에서 역산
UPDATE `order`
SET `settle_method` = IF(`card_surcharge_applied` = 1, 'CARD', 'CASH')
WHERE `settle_method` IS NULL
  AND `settle_amount` > 0;

-- 주의: 과거 0원 정산 row 는 기존 구조상(표식=settle_amount) 식별 불가 → NULL 유지.
--       해당 row 는 읽기 시 정책 폴백으로 처리, 다음 정산입력 저장 시 non-null 로 정착.

-- (3) 검증
-- 백필 후 분포
SELECT (`settle_amount` > 0) AS settled, `settle_method`, COUNT(*) AS cnt
FROM `order`
GROUP BY settled, `settle_method`;

-- settle_amount>0 인데 settle_method NULL 인 row = 0 이어야 정상
SELECT COUNT(*) AS leftover_null
FROM `order`
WHERE `settle_amount` > 0 AND `settle_method` IS NULL;

-- (4) 롤백 (코드 롤백 후에만 실행)
-- ALTER TABLE `order` DROP COLUMN `settle_method`;
