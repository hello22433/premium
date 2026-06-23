CREATE TABLE `classification` (
    `id` int NOT NULL AUTO_INCREMENT,
    `classification` varchar(100) NOT NULL,
    `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at` datetime(6) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- 마이그레이션: product 테이블의 classification varchar를 classificationId로 변경
-- ============================================================

-- 1. 기존 product 테이블의 고유한 classification 값들을 classification 테이블에 삽입
INSERT INTO `classification` (`classification`)
SELECT DISTINCT `classification`
FROM `product`
WHERE `classification` IS NOT NULL
  AND `classification` != ''
  AND `deleted_at` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `classification` c WHERE c.`classification` = `product`.`classification`
  );

-- 2. product 테이블에 classificationId 컬럼 추가 (NULL 허용)
ALTER TABLE `product`
ADD COLUMN `classification_id` int NULL COMMENT 'FK) classification.id 대분류'
AFTER `category`;

-- 3. product의 classification(varchar) 값과 매칭해서 classificationId 업데이트
UPDATE `product` p
INNER JOIN `classification` c ON p.`classification` = c.`classification`
SET p.`classification_id` = c.`id`
WHERE p.`classification` IS NOT NULL
  AND p.`classification` != '';

-- 4. 기존 classification(varchar) 컬럼 삭제
ALTER TABLE `product`
DROP COLUMN `classification`;

-- ============================================================
-- 롤백 스크립트 (필요시 사용)
-- ============================================================
-- ALTER TABLE `product` ADD COLUMN `classification` varchar(50) NULL COMMENT '대분류' AFTER `category`;
-- UPDATE `product` p INNER JOIN `classification` c ON p.`classification_id` = c.`id` SET p.`classification` = c.`classification`;
-- ALTER TABLE `product` DROP COLUMN `classification_id`;
-- DELETE FROM `classification` WHERE `id` > 0;