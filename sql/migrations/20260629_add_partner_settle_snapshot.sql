-- 컬럼 추가는 재실행 안전해야 한다. backfill 검증 실패(SIGNAL) 후 이 스크립트를 처음부터
-- 다시 실행하는 것이 운영 절차이므로, 컬럼이 이미 있으면 ALTER 를 건너뛴다.
DROP PROCEDURE IF EXISTS add_partner_settle_snapshot_columns;
DELIMITER //
CREATE PROCEDURE add_partner_settle_snapshot_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'order_product_mapping'
       AND COLUMN_NAME = 'partner_settle_price_adjustment'
  ) THEN
    ALTER TABLE `order_product_mapping`
      ADD COLUMN `partner_settle_price_adjustment` ENUM('DISCOUNT', 'ADDITIONAL') NULL COMMENT '[snapshot] 협력사 정산 시 사용되는 할인 방법';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'order_product_mapping'
       AND COLUMN_NAME = 'partner_settle_fee'
  ) THEN
    ALTER TABLE `order_product_mapping`
      ADD COLUMN `partner_settle_fee` INT NULL COMMENT '[snapshot] 협력사 정산 시 사용되는 수수료 (percent)';
  END IF;
END //
DELIMITER ;

CALL add_partner_settle_snapshot_columns();
DROP PROCEDURE IF EXISTS add_partner_settle_snapshot_columns;

-- =============================================================================
-- 배포시점 동결(containment): 기존 행을 findMatchingDiscount()(discount.matcher.ts)와
-- 동일한 우선순위/경계 규칙으로 backfill한다.
-- 우선순위: BRAND(BULK 또는 SECTION) > CATEGORY/PRODUCT_GROUP(BULK 또는 SECTION, 동시매칭 시 pricePercent 큰 쪽,
--          priceAdjustment 방향 충돌 시 매칭 실패 처리)
-- SECTION(가격구간)은 range 개수가 가변이라 정적 SQL로 재현 불가 → 커서로 range ASC 순회하며
-- discount.matcher.ts 의 findDiscountByMethod() 경계 판정을 그대로 절차화한다.
-- 매칭 결과가 없는 행만 fee=0/adjustment=NULL(정말로 할인 없음 확정값). 방향 충돌은 미확정으로 남기고
-- 스킵(로그 기록) → 운영자 수동 확인.
-- 가격 기준: order_product_mapping.snapshot_product_price 우선, 없으면 product.price
--           (buildPartnerSettleSnapshot() 호출부와 동일 기준).
-- 운영 전제: 새 애플리케이션 배포 후 실행한다. 구버전 앱이 migration 도중 신규 주문을
-- partner_settle_fee=NULL 로 insert하면 마지막 전체 테이블 검증에서 차단되므로, 실패 시
-- 주문 쓰기를 멈추거나 새 앱 배포 상태를 확인한 뒤 재실행한다.
-- 이 스크립트는 전체가 재실행 안전(idempotent)하다: 컬럼 추가는 존재 확인 후 수행하고,
-- backfill 은 partner_settle_fee IS NULL 인 행만 대상으로 하므로 이미 확정된 행은 다시 건드리지 않는다.
-- =============================================================================

DROP TABLE IF EXISTS `_partner_settle_backfill_skip_log`;
CREATE TABLE `_partner_settle_backfill_skip_log` (
  `mapping_id` INT NOT NULL,
  `reason` VARCHAR(100) NOT NULL,
  PRIMARY KEY (`mapping_id`)
) COMMENT = '20260629 backfill 시 자동 판정 불가로 스킵된 행 기록 (운영자 수동 확인용, 조회 후 DROP)';

-- 대상 행을 먼저 구체화(materialize)한다. MySQL 프로시저 커서가 UPDATE 대상과 동일 테이블을
-- 직접 SELECT하면 UPDATE 시점에 그 행이 커서의 WHERE 조건(partner_settle_fee IS NULL)을
-- 더 이상 만족하지 못하게 되어 스캔 위치가 흐트러지고 다음 행을 건너뛰는 미정의 동작이 발생한다
-- (실측: 2건 seed 검증 중 1건 처리 후 나머지 행이 통째로 스킵되는 현상 확인).
-- 커서 소스를 이 스냅샷 테이블로 분리해 원본 테이블 UPDATE와 완전히 격리한다.
DROP TEMPORARY TABLE IF EXISTS `_partner_settle_backfill_target`;
CREATE TEMPORARY TABLE `_partner_settle_backfill_target` (
  `mapping_id` INT NOT NULL PRIMARY KEY,
  `partner_company_id` INT NOT NULL,
  `brand_id` INT NOT NULL,
  `classification_id` INT NULL,
  `category` VARCHAR(50) NOT NULL,
  `effective_price` INT NOT NULL
);

-- 할인조건도 backfill 시작 시점 기준으로 구체화한다. 이후 커서 처리 중 운영자가
-- user_discount 를 수정해도 같은 migration 안의 row 들이 서로 다른 할인조건으로 박제되지 않게 한다.
DROP TEMPORARY TABLE IF EXISTS `_partner_settle_backfill_discount`;
CREATE TEMPORARY TABLE `_partner_settle_backfill_discount` LIKE `user_discount`;

DROP PROCEDURE IF EXISTS backfill_partner_settle_snapshot;
DELIMITER //
CREATE PROCEDURE backfill_partner_settle_snapshot()
BEGIN
  -- MySQL 규칙: 변수 DECLARE → 커서 DECLARE → 핸들러 DECLARE 순서 고정.
  DECLARE done INT DEFAULT FALSE;

  -- 커서 행 변수
  DECLARE v_mapping_id INT;
  DECLARE v_partner_company_id INT;
  DECLARE v_brand_id INT;
  DECLARE v_classification_id INT;
  DECLARE v_category VARCHAR(50);
  DECLARE v_price INT;

  -- BRAND BULK 매칭 결과
  DECLARE v_brand_fee INT;
  DECLARE v_brand_adj VARCHAR(20);

  -- CATEGORY / PRODUCT_GROUP 매칭 결과 (BULK 우선, 없으면 SECTION 커서로 산출)
  DECLARE v_category_fee INT;
  DECLARE v_category_adj VARCHAR(20);
  DECLARE v_group_fee INT;
  DECLARE v_group_adj VARCHAR(20);

  -- SECTION 순회용
  DECLARE v_section_done INT;
  DECLARE v_range_val INT;
  DECLARE v_compare_cond VARCHAR(20);
  DECLARE v_price_percent INT;
  DECLARE v_price_adjustment VARCHAR(20);
  DECLARE v_prev_upper INT;
  DECLARE v_matched_fee INT;
  DECLARE v_matched_adj VARCHAR(20);
  DECLARE v_in_range TINYINT;
  -- MORE/MORE_THAN 다음 행(LEAD) lookahead — lowerCheck && upperCheck 판정용
  DECLARE v_next_range_val INT;
  DECLARE v_next_compare_cond VARCHAR(20);
  DECLARE v_lower_check TINYINT;
  DECLARE v_upper_check TINYINT;
  DECLARE v_skip_next TINYINT;

  -- 대상: 사전 구체화된 스냅샷 테이블에서 순회 (원본 테이블 UPDATE와 커서 소스 분리).
  DECLARE cur CURSOR FOR
    SELECT mapping_id, partner_company_id, brand_id, classification_id, category, effective_price
      FROM `_partner_settle_backfill_target`;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO v_mapping_id, v_partner_company_id, v_brand_id, v_classification_id, v_category, v_price;
    IF done THEN
      LEAVE read_loop;
    END IF;

    -- 1) BRAND BULK (최우선, brand.name_korean = ud.primary_category)
    -- 단건 SELECT ... INTO 는 row 없음도 NOT FOUND handler 를 태우므로 scalar subquery 로 조회한다.
    SET v_brand_fee = (
      SELECT ud.price_percent
        FROM `_partner_settle_backfill_discount` ud
        INNER JOIN `brand` b ON b.id = v_brand_id
       WHERE ud.partner_company_id = v_partner_company_id
         AND ud.category = 'BRAND'
         AND ud.method = 'BULK'
         AND ud.primary_category = b.name_korean
       LIMIT 1
    );
    SET v_brand_adj = (
      SELECT ud.price_adjustment
        FROM `_partner_settle_backfill_discount` ud
        INNER JOIN `brand` b ON b.id = v_brand_id
       WHERE ud.partner_company_id = v_partner_company_id
         AND ud.category = 'BRAND'
         AND ud.method = 'BULK'
         AND ud.primary_category = b.name_korean
       LIMIT 1
    );

    IF v_brand_fee IS NULL THEN
      SET v_section_done = FALSE;
      SET v_prev_upper = 0;
      SET v_matched_fee = NULL;
      SET v_matched_adj = NULL;

      BEGIN
        DECLARE brand_section_cur CURSOR FOR
          SELECT CAST(ud.`range` AS SIGNED) AS range_val,
                 ud.compare_condition,
                 ud.price_percent,
                 ud.price_adjustment,
                 LEAD(CAST(ud.`range` AS SIGNED)) OVER (ORDER BY CAST(ud.`range` AS SIGNED) ASC) AS next_range_val,
                 LEAD(ud.compare_condition) OVER (ORDER BY CAST(ud.`range` AS SIGNED) ASC) AS next_compare_cond
            FROM `_partner_settle_backfill_discount` ud
           WHERE ud.partner_company_id = v_partner_company_id
             AND ud.category = 'BRAND'
             AND ud.method = 'SECTION'
             AND ud.primary_category = (SELECT b.name_korean FROM `brand` b WHERE b.id = v_brand_id)
           ORDER BY CAST(ud.`range` AS SIGNED) ASC;
        DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_section_done = TRUE;

        OPEN brand_section_cur;
        brand_section_loop: LOOP
          FETCH brand_section_cur INTO v_range_val, v_compare_cond, v_price_percent, v_price_adjustment, v_next_range_val, v_next_compare_cond;
          IF v_section_done THEN
            LEAVE brand_section_loop;
          END IF;

          SET v_in_range = FALSE;
          SET v_skip_next = FALSE;
          IF v_compare_cond = 'LESS' THEN
            IF v_price > v_prev_upper AND v_price <= v_range_val THEN
              SET v_in_range = TRUE;
            END IF;
          ELSEIF v_compare_cond = 'LESS_THAN' THEN
            IF v_price > v_prev_upper AND v_price < v_range_val THEN
              SET v_in_range = TRUE;
            END IF;
          ELSEIF v_compare_cond IN ('OVER', 'MORE_THAN') THEN
            IF v_compare_cond = 'OVER' THEN
              SET v_lower_check = (v_price >= v_range_val);
            ELSE
              SET v_lower_check = (v_price > v_range_val);
            END IF;

            IF v_next_compare_cond IN ('LESS', 'LESS_THAN') THEN
              IF v_next_compare_cond = 'LESS' THEN
                SET v_upper_check = (v_price <= v_next_range_val);
                SET v_prev_upper = v_next_range_val;
              ELSE
                SET v_upper_check = (v_price < v_next_range_val);
                SET v_prev_upper = v_next_range_val - 1;
              END IF;
              SET v_in_range = v_lower_check AND v_upper_check;
              SET v_skip_next = TRUE;
            ELSE
              SET v_in_range = v_lower_check;
            END IF;
          END IF;

          IF v_in_range AND v_matched_fee IS NULL THEN
            SET v_matched_fee = v_price_percent;
            SET v_matched_adj = v_price_adjustment;
          END IF;

          IF v_compare_cond = 'LESS' THEN
            SET v_prev_upper = v_range_val;
          ELSEIF v_compare_cond = 'LESS_THAN' THEN
            SET v_prev_upper = v_range_val - 1;
          END IF;

          IF v_skip_next THEN
            FETCH brand_section_cur INTO v_range_val, v_compare_cond, v_price_percent, v_price_adjustment, v_next_range_val, v_next_compare_cond;
            IF v_section_done THEN
              LEAVE brand_section_loop;
            END IF;
          END IF;
        END LOOP;
        CLOSE brand_section_cur;
      END;

      SET v_brand_fee = v_matched_fee;
      SET v_brand_adj = v_matched_adj;
    END IF;

    IF v_brand_fee IS NOT NULL THEN
      UPDATE `order_product_mapping`
         SET partner_settle_fee = v_brand_fee,
             partner_settle_price_adjustment = v_brand_adj
       WHERE id = v_mapping_id;
    ELSE
      -- 2) CATEGORY: BULK 우선, 없으면 SECTION 구간 판정
      SET v_category_fee = (
        SELECT ud.price_percent
          FROM `_partner_settle_backfill_discount` ud
         WHERE ud.partner_company_id = v_partner_company_id
           AND ud.category = 'CATEGORY'
           AND ud.method = 'BULK'
           AND ud.classification_id = v_classification_id
         LIMIT 1
      );
      SET v_category_adj = (
        SELECT ud.price_adjustment
          FROM `_partner_settle_backfill_discount` ud
         WHERE ud.partner_company_id = v_partner_company_id
           AND ud.category = 'CATEGORY'
           AND ud.method = 'BULK'
           AND ud.classification_id = v_classification_id
         LIMIT 1
      );

      IF v_category_fee IS NULL THEN
        -- SECTION 커서: range ASC 순회, findDiscountByMethod() 경계 규칙 그대로 절차화
        SET v_section_done = FALSE;
        SET v_prev_upper = 0;
        SET v_matched_fee = NULL;
        SET v_matched_adj = NULL;

        BEGIN
          -- LEAD()로 다음 행(range ASC 기준 바로 다음 구간)을 같은 row에 끌어옴.
          -- MORE/MORE_THAN 은 다음 행이 LESS/LESS_THAN 이면 그 상한까지 같이 만족해야 매칭
          -- (findDiscountByMethod() 의 lowerCheck && upperCheck 규칙과 동일 — 하한만 보면 오매칭됨).
          DECLARE section_cur CURSOR FOR
            SELECT CAST(ud.`range` AS SIGNED) AS range_val,
                   ud.compare_condition,
                   ud.price_percent,
                   ud.price_adjustment,
                   LEAD(CAST(ud.`range` AS SIGNED)) OVER (ORDER BY CAST(ud.`range` AS SIGNED) ASC) AS next_range_val,
                   LEAD(ud.compare_condition) OVER (ORDER BY CAST(ud.`range` AS SIGNED) ASC) AS next_compare_cond
              FROM `_partner_settle_backfill_discount` ud
             WHERE ud.partner_company_id = v_partner_company_id
               AND ud.category = 'CATEGORY'
               AND ud.method = 'SECTION'
               AND ud.classification_id = v_classification_id
             ORDER BY CAST(ud.`range` AS SIGNED) ASC;
          DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_section_done = TRUE;

          OPEN section_cur;
          section_loop: LOOP
            FETCH section_cur INTO v_range_val, v_compare_cond, v_price_percent, v_price_adjustment, v_next_range_val, v_next_compare_cond;
            IF v_section_done THEN
              LEAVE section_loop;
            END IF;

            SET v_in_range = FALSE;
            SET v_skip_next = FALSE;
            IF v_compare_cond = 'LESS' THEN
              IF v_price > v_prev_upper AND v_price <= v_range_val THEN
                SET v_in_range = TRUE;
              END IF;
            ELSEIF v_compare_cond = 'LESS_THAN' THEN
              IF v_price > v_prev_upper AND v_price < v_range_val THEN
                SET v_in_range = TRUE;
              END IF;
            ELSEIF v_compare_cond IN ('OVER', 'MORE_THAN') THEN
              IF v_compare_cond = 'OVER' THEN
                SET v_lower_check = (v_price >= v_range_val);
              ELSE
                SET v_lower_check = (v_price > v_range_val);
              END IF;

              IF v_next_compare_cond IN ('LESS', 'LESS_THAN') THEN
                IF v_next_compare_cond = 'LESS' THEN
                  SET v_upper_check = (v_price <= v_next_range_val);
                  SET v_prev_upper = v_next_range_val;
                ELSE
                  SET v_upper_check = (v_price < v_next_range_val);
                  SET v_prev_upper = v_next_range_val - 1;
                END IF;
                SET v_in_range = v_lower_check AND v_upper_check;
                -- TS 원본과 동일하게 다음 행(짝지어진 상한)은 이미 소비했으므로 건너뜀
                SET v_skip_next = TRUE;
              ELSE
                SET v_in_range = v_lower_check;
              END IF;
            END IF;

            IF v_in_range AND v_matched_fee IS NULL THEN
              SET v_matched_fee = v_price_percent;
              SET v_matched_adj = v_price_adjustment;
            END IF;

            IF v_compare_cond = 'LESS' THEN
              SET v_prev_upper = v_range_val;
            ELSEIF v_compare_cond = 'LESS_THAN' THEN
              SET v_prev_upper = v_range_val - 1;
            END IF;

            IF v_skip_next THEN
              FETCH section_cur INTO v_range_val, v_compare_cond, v_price_percent, v_price_adjustment, v_next_range_val, v_next_compare_cond;
              IF v_section_done THEN
                LEAVE section_loop;
              END IF;
            END IF;
          END LOOP;
          CLOSE section_cur;
        END;

        SET v_category_fee = v_matched_fee;
        SET v_category_adj = v_matched_adj;
      END IF;

      -- 3) PRODUCT_GROUP: BULK 우선, 없으면 SECTION 구간 판정 (CATEGORY와 동일 절차)
      SET v_group_fee = (
        SELECT ud.price_percent
          FROM `_partner_settle_backfill_discount` ud
         WHERE ud.partner_company_id = v_partner_company_id
           AND ud.category = 'PRODUCT_GROUP'
           AND ud.method = 'BULK'
           AND ud.`group` = v_category
         LIMIT 1
      );
      SET v_group_adj = (
        SELECT ud.price_adjustment
          FROM `_partner_settle_backfill_discount` ud
         WHERE ud.partner_company_id = v_partner_company_id
           AND ud.category = 'PRODUCT_GROUP'
           AND ud.method = 'BULK'
           AND ud.`group` = v_category
         LIMIT 1
      );

      IF v_group_fee IS NULL THEN
        SET v_section_done = FALSE;
        SET v_prev_upper = 0;
        SET v_matched_fee = NULL;
        SET v_matched_adj = NULL;

        BEGIN
          DECLARE group_section_cur CURSOR FOR
            SELECT CAST(ud.`range` AS SIGNED) AS range_val,
                   ud.compare_condition,
                   ud.price_percent,
                   ud.price_adjustment,
                   LEAD(CAST(ud.`range` AS SIGNED)) OVER (ORDER BY CAST(ud.`range` AS SIGNED) ASC) AS next_range_val,
                   LEAD(ud.compare_condition) OVER (ORDER BY CAST(ud.`range` AS SIGNED) ASC) AS next_compare_cond
              FROM `_partner_settle_backfill_discount` ud
             WHERE ud.partner_company_id = v_partner_company_id
               AND ud.category = 'PRODUCT_GROUP'
               AND ud.method = 'SECTION'
               AND ud.`group` = v_category
             ORDER BY CAST(ud.`range` AS SIGNED) ASC;
          DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_section_done = TRUE;

          OPEN group_section_cur;
          group_section_loop: LOOP
            FETCH group_section_cur INTO v_range_val, v_compare_cond, v_price_percent, v_price_adjustment, v_next_range_val, v_next_compare_cond;
            IF v_section_done THEN
              LEAVE group_section_loop;
            END IF;

            SET v_in_range = FALSE;
            SET v_skip_next = FALSE;
            IF v_compare_cond = 'LESS' THEN
              IF v_price > v_prev_upper AND v_price <= v_range_val THEN
                SET v_in_range = TRUE;
              END IF;
            ELSEIF v_compare_cond = 'LESS_THAN' THEN
              IF v_price > v_prev_upper AND v_price < v_range_val THEN
                SET v_in_range = TRUE;
              END IF;
            ELSEIF v_compare_cond IN ('OVER', 'MORE_THAN') THEN
              IF v_compare_cond = 'OVER' THEN
                SET v_lower_check = (v_price >= v_range_val);
              ELSE
                SET v_lower_check = (v_price > v_range_val);
              END IF;

              IF v_next_compare_cond IN ('LESS', 'LESS_THAN') THEN
                IF v_next_compare_cond = 'LESS' THEN
                  SET v_upper_check = (v_price <= v_next_range_val);
                  SET v_prev_upper = v_next_range_val;
                ELSE
                  SET v_upper_check = (v_price < v_next_range_val);
                  SET v_prev_upper = v_next_range_val - 1;
                END IF;
                SET v_in_range = v_lower_check AND v_upper_check;
                SET v_skip_next = TRUE;
              ELSE
                SET v_in_range = v_lower_check;
              END IF;
            END IF;

            IF v_in_range AND v_matched_fee IS NULL THEN
              SET v_matched_fee = v_price_percent;
              SET v_matched_adj = v_price_adjustment;
            END IF;

            IF v_compare_cond = 'LESS' THEN
              SET v_prev_upper = v_range_val;
            ELSEIF v_compare_cond = 'LESS_THAN' THEN
              SET v_prev_upper = v_range_val - 1;
            END IF;

            IF v_skip_next THEN
              FETCH group_section_cur INTO v_range_val, v_compare_cond, v_price_percent, v_price_adjustment, v_next_range_val, v_next_compare_cond;
              IF v_section_done THEN
                LEAVE group_section_loop;
              END IF;
            END IF;
          END LOOP;
          CLOSE group_section_cur;
        END;

        SET v_group_fee = v_matched_fee;
        SET v_group_adj = v_matched_adj;
      END IF;

      -- 4) CATEGORY / PRODUCT_GROUP 결합 판정 (findMatchingDiscount() 2번 규칙과 동일)
      IF v_category_fee IS NOT NULL AND v_group_fee IS NOT NULL THEN
        IF v_category_adj <=> v_group_adj THEN
          -- 방향 동일: 더 높은 비율 채택
          IF v_category_fee >= v_group_fee THEN
            UPDATE `order_product_mapping`
               SET partner_settle_fee = v_category_fee, partner_settle_price_adjustment = v_category_adj
             WHERE id = v_mapping_id;
          ELSE
            UPDATE `order_product_mapping`
               SET partner_settle_fee = v_group_fee, partner_settle_price_adjustment = v_group_adj
             WHERE id = v_mapping_id;
          END IF;
        ELSE
          -- 방향 충돌: 자동 판정 불가 → 미확정(NULL) 유지, 스킵 로그만 기록
          INSERT INTO `_partner_settle_backfill_skip_log` (mapping_id, reason)
          VALUES (v_mapping_id, 'CATEGORY/PRODUCT_GROUP priceAdjustment 방향 충돌')
          ON DUPLICATE KEY UPDATE reason = VALUES(reason);
        END IF;
      ELSEIF v_category_fee IS NOT NULL THEN
        UPDATE `order_product_mapping`
           SET partner_settle_fee = v_category_fee, partner_settle_price_adjustment = v_category_adj
         WHERE id = v_mapping_id;
      ELSEIF v_group_fee IS NOT NULL THEN
        UPDATE `order_product_mapping`
           SET partner_settle_fee = v_group_fee, partner_settle_price_adjustment = v_group_adj
         WHERE id = v_mapping_id;
      ELSE
        -- 매칭되는 할인 조건 자체가 없음 → 정말로 할인 없음(정상 확정값)
        UPDATE `order_product_mapping`
           SET partner_settle_fee = 0, partner_settle_price_adjustment = NULL
         WHERE id = v_mapping_id;
      END IF;
    END IF;

    -- 다음 커서 반복을 위해 브랜드 매칭 변수 초기화
    SET v_brand_fee = NULL;
    SET v_brand_adj = NULL;
    SET v_category_fee = NULL;
    SET v_group_fee = NULL;
  END LOOP;
  CLOSE cur;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS assert_partner_settle_snapshot_backfill;
DELIMITER //
CREATE PROCEDURE assert_partner_settle_snapshot_backfill()
BEGIN
  DECLARE v_skip_count INT DEFAULT 0;
  DECLARE v_remaining_count INT DEFAULT 0;
  DECLARE v_remaining_null_total INT DEFAULT 0;

  SELECT COUNT(*)
    INTO v_skip_count
    FROM `_partner_settle_backfill_skip_log`;

  SELECT COUNT(*)
    INTO v_remaining_count
    FROM `order_product_mapping` opm
    INNER JOIN `product` p ON p.id = opm.product_id
   WHERE opm.partner_settle_fee IS NULL
     AND p.partner_company_id IS NOT NULL
     AND opm.id NOT IN (SELECT mapping_id FROM `_partner_settle_backfill_skip_log`);

  -- target 구체화 이후 구버전 앱이 새 주문을 insert했거나, backfill 대상 밖 NULL row가 있으면
  -- skip log 여부와 무관하게 전체 테이블 기준으로 차단한다.
  SELECT COUNT(*)
    INTO v_remaining_null_total
    FROM `order_product_mapping` opm
    INNER JOIN `product` p ON p.id = opm.product_id
   WHERE opm.partner_settle_fee IS NULL
     AND p.partner_company_id IS NOT NULL;

  IF v_skip_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'partner settle backfill blocked: CATEGORY/PRODUCT_GROUP priceAdjustment conflict';
  END IF;

  IF v_remaining_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'partner settle backfill blocked: unresolved NULL rows remain';
  END IF;

  IF v_remaining_null_total > v_skip_count THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'partner settle backfill blocked: unresolved NULL rows remain after full-table verification';
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS run_partner_settle_snapshot_backfill;
DELIMITER //
CREATE PROCEDURE run_partner_settle_snapshot_backfill()
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  INSERT INTO `_partner_settle_backfill_target`
    SELECT opm.id,
           p.partner_company_id,
           p.brand_id,
           p.classification_id,
           p.category,
           COALESCE(opm.snapshot_product_price, p.price)
      FROM `order_product_mapping` opm
      INNER JOIN `product` p ON p.id = opm.product_id
     WHERE opm.partner_settle_fee IS NULL
       AND p.partner_company_id IS NOT NULL;

  INSERT INTO `_partner_settle_backfill_discount`
    SELECT *
      FROM `user_discount`
     WHERE deleted_at IS NULL;

  CALL backfill_partner_settle_snapshot();

  -- 검증: 방향 충돌로 스킵된 행 (0 row면 전량 자동 확정)
  SELECT * FROM `_partner_settle_backfill_skip_log`;

  -- 검증: 여전히 NULL인 행이 스킵 로그와 정확히 일치하는지 (그 외 NULL 잔존 시 로직 누락 의심)
  SELECT COUNT(*) AS remaining_null_not_in_skip_log
    FROM `order_product_mapping` opm
    INNER JOIN `product` p ON p.id = opm.product_id
   WHERE opm.partner_settle_fee IS NULL
     AND p.partner_company_id IS NOT NULL
     AND opm.id NOT IN (SELECT mapping_id FROM `_partner_settle_backfill_skip_log`);
  -- 위 결과는 반드시 0 이어야 한다.

  CALL assert_partner_settle_snapshot_backfill();

  COMMIT;
END //
DELIMITER ;

CALL run_partner_settle_snapshot_backfill();

DROP PROCEDURE IF EXISTS run_partner_settle_snapshot_backfill;
DROP PROCEDURE IF EXISTS assert_partner_settle_snapshot_backfill;
DROP PROCEDURE IF EXISTS backfill_partner_settle_snapshot;
DROP TEMPORARY TABLE IF EXISTS `_partner_settle_backfill_target`;
DROP TEMPORARY TABLE IF EXISTS `_partner_settle_backfill_discount`;

-- 확인 후 DROP: DROP TABLE `_partner_settle_backfill_skip_log`;
