-- wallet_account 에 홈(발급) 회사 식별자(owner_company_id) 추가.
-- 정산코드↔회사 링크가 지금은 user(company_id + settlement_code)로만 성립해, 유저 0인 코드는
-- 목록/재배정/rename 에서 사라진다(데이터 유실 버그, P1). owner_company_id 로 홈 회사를 결정론적으로 고정한다.
-- N:M 주의: 한 코드를 여러 회사 유저가 공유할 수 있으므로 "홈(발급) 회사"와 "사용 회사"를 구분한다 — owner_company_id 는 홈 회사만.
-- 스펙: plans/2026-07-20-settlement-code-list-enhancement.md §2.

-- (1) 컬럼 추가 (NULL 허용; 백필·활성화 후 SETTLEMENT_CODE 는 NOT NULL 불변식, §4.4 게이트)
ALTER TABLE `wallet_account`
  ADD COLUMN `owner_company_id` INT NULL
    COMMENT 'SETTLEMENT_CODE 홈(발급) 회사 id. N:M 사용 회사와 별개, 비정산코드 owner는 NULL' AFTER `owner_id`;

-- (2) 조회 인덱스 — 목록 도출(owner_company_id = ? AND owner_type='SETTLEMENT_CODE')
CREATE INDEX `idx_wallet_account_owner_company` ON `wallet_account` (`owner_company_id`, `owner_type`);

-- (3) 백필-A: 네이밍 우선 — company-{id}[-...] → id 파싱 (결정적)
UPDATE `wallet_account`
   SET `owner_company_id` = CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(`owner_id`, '-', 2), '-', -1) AS UNSIGNED)
 WHERE `owner_type` = 'SETTLEMENT_CODE'
   AND `owner_company_id` IS NULL
   AND `owner_id` REGEXP '^company-[0-9]+(-.*)?$';

-- (4) 백필-B: 네이밍 비표준(운영자 rename 등) → 현재 유저의 company 로 폴백(단일 회사인 코드만 자동)
UPDATE `wallet_account` w
  JOIN (
    SELECT `settlement_code`, COUNT(DISTINCT `company_id`) AS cc, MIN(`company_id`) AS company_id
      FROM `user`
     WHERE `settlement_code` <> '' AND `company_id` IS NOT NULL
     GROUP BY `settlement_code`
  ) u ON u.`settlement_code` = w.`owner_id` AND u.cc = 1
   SET w.`owner_company_id` = u.company_id
 WHERE w.`owner_type` = 'SETTLEMENT_CODE' AND w.`owner_company_id` IS NULL;

-- (5) 검증-A (필수 게이트): owner_company_id 미판별(NULL) 잔재 → 운영자 수동 지정. 0건 될 때까지 활성화 금지.
SELECT `owner_id`, `deposit_balance`, `credit_limit`
  FROM `wallet_account`
 WHERE `owner_type` = 'SETTLEMENT_CODE'
   AND `owner_company_id` IS NULL
 ORDER BY `id`;

-- (6) 검증-B (정합): 네이밍 파싱값 ≠ 유저 company (rename 흔적/오염) → 수동 확인.
SELECT w.`owner_id`, w.`owner_company_id` AS parsed_owner, u.company_id AS single_user_company
  FROM `wallet_account` w
  JOIN (
    SELECT `settlement_code`, COUNT(DISTINCT `company_id`) AS cc, MIN(`company_id`) AS company_id
      FROM `user`
     WHERE `settlement_code` <> '' AND `company_id` IS NOT NULL
     GROUP BY `settlement_code`
  ) u ON u.`settlement_code` = w.`owner_id` AND u.cc = 1
 WHERE w.`owner_type` = 'SETTLEMENT_CODE'
   AND w.`owner_company_id` IS NOT NULL
   AND w.`owner_company_id` <> u.company_id
 ORDER BY w.`owner_id`;

-- (7) 롤백 (코드 롤백 후에만 실행)
-- DROP INDEX `idx_wallet_account_owner_company` ON `wallet_account`;
-- ALTER TABLE `wallet_account` DROP COLUMN `owner_company_id`;
