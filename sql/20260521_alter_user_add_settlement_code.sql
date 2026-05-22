-- PR1a Wallet: user.settlement_code 컬럼 추가
-- backfill 이후 NOT NULL 강제 (backfill SQL에서 default 부여)
ALTER TABLE `user`
  ADD COLUMN `settlement_code` VARCHAR(50) NOT NULL DEFAULT '' COMMENT 'wallet_account.owner_id 매핑 키 (default: company-{companyId})' AFTER `company_id`;

-- backfill 진행 후 별도 마이그레이션에서 NOT NULL 강제 가능 (DEFAULT 유지)
-- 인덱스: wallet_account_resolver 조회용
CREATE INDEX `idx_user_settlement_code` ON `user` (`settlement_code`);
