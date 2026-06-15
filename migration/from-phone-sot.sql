-- From-Phone SoT Migration (멱등)
-- 실행 시점: dual-write 코드 배포 후, FROM_PHONE_SOT_ENFORCE 활성화 전.
-- 순서: 스키마가드 → 활성중복 정리 → 생존행 정규화 → 시스템번호 정리 → 백필 → 기본재선정/mirror → 인덱스 → drift검증
-- 요구: MySQL 8.0+ (generated STORED column, REGEXP_REPLACE, ROW_NUMBER). 실행 전 SELECT VERSION(); 확인.

-- ── 0. 스키마 가드: active_from_key 생성 컬럼 (재실행 안전) ──
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_from_definition' AND COLUMN_NAME = 'active_from_key'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `order_from_definition` ADD COLUMN `active_from_key` VARCHAR(255)
     GENERATED ALWAYS AS (
       CASE WHEN `deleted_at` IS NULL
         THEN CONCAT(`user_id`, '':'', `type`, '':'', `from`) ELSE NULL END
     ) STORED',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 1. 활성 중복 정리 (PHONE 한정, 정규화 기준): 그룹당 APPROVED→is_default→id ASC 1행 생존, 나머지 soft delete ──
-- EMAIL 은 숫자 정규화하면 전부 빈문자열로 뭉쳐 오탐 → 반드시 type='PHONE' 한정.
UPDATE `order_from_definition` d
JOIN (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, REGEXP_REPLACE(`from`, '[^0-9]', '')
      ORDER BY (request_status = 'APPROVED') DESC, is_default DESC, id ASC
    ) AS rn
  FROM `order_from_definition`
  WHERE deleted_at IS NULL AND type = 'PHONE'
) ranked ON ranked.id = d.id
SET d.deleted_at = NOW()
WHERE ranked.rn > 1;

-- ── 2. 생존 활성 PHONE 의 from 정규화 갱신 (raw → 숫자만). active_from_key 가 raw from 기반이므로 인덱스 생성 전 수행 ──
UPDATE `order_from_definition`
SET `from` = REGEXP_REPLACE(`from`, '[^0-9]', '')
WHERE deleted_at IS NULL
  AND type = 'PHONE'
  AND `from` <> REGEXP_REPLACE(`from`, '[^0-9]', '');

-- ── 2.5 시스템번호(16443614) 활성 PHONE 행 soft-delete ──
-- 불변식 "시스템번호는 user APPROVED 행으로 절대 존재하지 않는다" 보장.
UPDATE `order_from_definition`
SET deleted_at = NOW()
WHERE deleted_at IS NULL
  AND type = 'PHONE'
  AND REGEXP_REPLACE(`from`, '[^0-9]', '') = '16443614';

-- ── 3. 백필: APPROVED PHONE 없고 user.from_phone_number 있고 시스템번호 아닌 경우 INSERT ──
INSERT INTO `order_from_definition`
  (`type`, `user_id`, `from`, `request_status`, `is_default`, `telecom_cert_type`, `created_at`, `updated_at`)
SELECT 'PHONE', u.id, REGEXP_REPLACE(u.from_phone_number, '[^0-9]', ''),
       'APPROVED', 0, 'PRE_DELIVERED', NOW(), NOW()
FROM `user` u
WHERE u.from_phone_number IS NOT NULL
  AND REGEXP_REPLACE(u.from_phone_number, '[^0-9]', '') <> ''
  AND REGEXP_REPLACE(u.from_phone_number, '[^0-9]', '') <> '16443614'
  AND NOT EXISTS (
    SELECT 1 FROM `order_from_definition` o
    WHERE o.user_id = u.id AND o.type = 'PHONE'
      AND o.request_status = 'APPROVED' AND o.deleted_at IS NULL
  )
  -- 동일 정규화 from 의 활성행(PENDING/REJECTED 포함)이 있으면 백필 금지 → active_from_key 유니크 충돌 방지
  AND NOT EXISTS (
    SELECT 1 FROM `order_from_definition` o
    WHERE o.user_id = u.id AND o.type = 'PHONE' AND o.deleted_at IS NULL
      AND REGEXP_REPLACE(o.`from`, '[^0-9]', '') = REGEXP_REPLACE(u.from_phone_number, '[^0-9]', '')
  );

-- ── 4. 기본 재선정: user별 활성 APPROVED PHONE 정확히 1개 ──
-- spec 우선순위 = mirror 일치 → 기존 default → id ASC.
-- 전체 해제(4b)가 기존 default 정보를 지우므로, 해제 전에 기존 default id 를 임시 테이블에 보존(4a).
DROP TEMPORARY TABLE IF EXISTS `tmp_prev_default`;
CREATE TEMPORARY TABLE `tmp_prev_default` AS
  SELECT id FROM `order_from_definition`
  WHERE type = 'PHONE' AND is_default = 1 AND deleted_at IS NULL;

-- 4b. 전체 기본 해제
UPDATE `order_from_definition`
SET is_default = 0
WHERE type = 'PHONE' AND is_default = 1 AND deleted_at IS NULL;

-- 4c. user별 우선순위(mirror 일치 → 기존 default → id ASC) 1행 기본 설정
-- tmp_prev_default 는 LEFT JOIN 으로 1회만 읽는다 ("can't reopen temp table" 회피)
UPDATE `order_from_definition` d
JOIN (
  SELECT o.id,
    ROW_NUMBER() OVER (
      PARTITION BY o.user_id
      ORDER BY
        (REGEXP_REPLACE(IFNULL(u.from_phone_number,''), '[^0-9]', '') = o.`from`) DESC,
        (p.id IS NOT NULL) DESC,
        o.id ASC
    ) AS rn
  FROM `order_from_definition` o
  JOIN `user` u ON u.id = o.user_id
  LEFT JOIN `tmp_prev_default` p ON p.id = o.id
  WHERE o.type = 'PHONE' AND o.request_status = 'APPROVED' AND o.deleted_at IS NULL
) pick ON pick.id = d.id
SET d.is_default = 1
WHERE pick.rn = 1;

DROP TEMPORARY TABLE IF EXISTS `tmp_prev_default`;

-- ── 5. mirror 전체 재조정 ──
-- 5a. 기본 PHONE 있는 user → mirror = 기본 from
UPDATE `user` u
JOIN `order_from_definition` o
  ON o.user_id = u.id AND o.type = 'PHONE' AND o.is_default = 1 AND o.deleted_at IS NULL
SET u.from_phone_number = o.`from`;

-- 5b. 활성 APPROVED PHONE 없는 user → mirror NULL
UPDATE `user` u
SET u.from_phone_number = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM `order_from_definition` o
  WHERE o.user_id = u.id AND o.type = 'PHONE'
    AND o.request_status = 'APPROVED' AND o.deleted_at IS NULL
);

-- ── 6. 인덱스 (재실행 가드) ──
SET @uq_exists := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_from_definition' AND INDEX_NAME = 'uq_order_from_active');
SET @sql := IF(@uq_exists = 0,
  'CREATE UNIQUE INDEX `uq_order_from_active` ON `order_from_definition`(`active_from_key`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx_exists := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_from_definition' AND INDEX_NAME = 'idx_order_from_lookup');
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX `idx_order_from_lookup` ON `order_from_definition`(`user_id`, `type`, `request_status`, `is_default`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 7. DRIFT 검증 (각 0 rows 이어야 함) ──
-- 7a. APPROVED PHONE 있는 user 의 기본 PHONE count 가 정확히 1이 아닌 경우 (0개=불변식 위반, >1=중복)
SELECT g.user_id, g.approved_cnt, g.default_cnt FROM (
  SELECT user_id,
    COUNT(*) AS approved_cnt,
    SUM(CASE WHEN is_default=1 THEN 1 ELSE 0 END) AS default_cnt
  FROM `order_from_definition`
  WHERE type='PHONE' AND request_status='APPROVED' AND deleted_at IS NULL
  GROUP BY user_id
) g
WHERE g.default_cnt <> 1;
-- 7b. APPROVED PHONE 있는데 mirror NULL
SELECT u.id FROM `user` u
WHERE u.from_phone_number IS NULL AND EXISTS (
  SELECT 1 FROM `order_from_definition` o WHERE o.user_id=u.id AND o.type='PHONE'
    AND o.request_status='APPROVED' AND o.deleted_at IS NULL);
-- 7c. APPROVED PHONE 없는데 mirror NOT NULL
SELECT u.id FROM `user` u
WHERE u.from_phone_number IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `order_from_definition` o WHERE o.user_id=u.id AND o.type='PHONE'
    AND o.request_status='APPROVED' AND o.deleted_at IS NULL);
-- 7d. mirror != 기본 from
SELECT u.id FROM `user` u
JOIN `order_from_definition` o ON o.user_id=u.id AND o.type='PHONE' AND o.is_default=1 AND o.deleted_at IS NULL
WHERE u.from_phone_number <> o.`from`;
-- 7e. 시스템번호(16443614) 가 활성 PHONE 으로 남아있음
SELECT id FROM `order_from_definition`
WHERE deleted_at IS NULL AND type='PHONE' AND REGEXP_REPLACE(`from`, '[^0-9]', '') = '16443614';
