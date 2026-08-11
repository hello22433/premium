-- 신세계(brand_id=171) 기존 상품 137개의 명칭 변경.
-- 운영 적용 전 아래 사전 조회 결과를 반드시 확인한다.
SELECT id, code, name, price
FROM product
WHERE brand_id = 171
ORDER BY id;

SELECT COUNT(*) AS expected_update_count
FROM product
WHERE brand_id = 171
  AND name LIKE '%신세계 상품권%';

DROP PROCEDURE IF EXISTS migrate_ssg_mobile_exchange_voucher_name;
DELIMITER $$
CREATE PROCEDURE migrate_ssg_mobile_exchange_voucher_name()
BEGIN
  DECLARE target_count INT DEFAULT 0;
  DECLARE changed_count INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  SELECT COUNT(*) INTO target_count
  FROM product
  WHERE brand_id = 171
    AND name LIKE '%신세계 상품권%'
  FOR UPDATE;

  IF target_count <> 137 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = '중단: brand_id=171의 변경 대상 상품 수가 137개가 아닙니다.';
  END IF;

  UPDATE product
  SET name = REPLACE(name, '신세계 상품권', '신세계 모바일 교환권')
  WHERE brand_id = 171
    AND name LIKE '%신세계 상품권%';

  SET changed_count = ROW_COUNT();
  IF changed_count <> 137 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = '중단: 실제 변경 행 수가 137개가 아닙니다.';
  END IF;

  COMMIT;
END$$
DELIMITER ;

CALL migrate_ssg_mobile_exchange_voucher_name();
DROP PROCEDURE migrate_ssg_mobile_exchange_voucher_name;

-- 사후 검증: old_name_count=0, new_name_count=137이어야 한다.
SELECT
  SUM(name LIKE '%신세계 상품권%') AS old_name_count,
  SUM(name LIKE '%신세계 모바일 교환권%') AS new_name_count
FROM product
WHERE brand_id = 171;

SELECT id, code, name, price
FROM product
WHERE brand_id = 171
ORDER BY id;

-- 롤백이 필요할 때만 아래 문장을 별도로 실행한다.
-- UPDATE product
-- SET name = REPLACE(name, '신세계 모바일 교환권', '신세계 상품권')
-- WHERE brand_id = 171
--   AND name LIKE '%신세계 모바일 교환권%';
