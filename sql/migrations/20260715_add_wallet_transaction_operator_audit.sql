-- wallet_transaction 을 금액 변경의 감사 정본으로 승격.
-- 운영자 수동 거래(정산코드 예치금 충전 등)의 실행 주체와 전후 잔액을 원장에 직접 보존한다.
-- (activity_log 는 보조·best-effort 로 강등 — 로그 실패가 충전 성공을 되돌리지 않음.)

-- (1) 컬럼 추가 (모두 NULL 허용; 기존 주문 흐름은 영향 없음, 신규 거래부터 채워짐)
ALTER TABLE `wallet_transaction`
  ADD COLUMN `balance_before` INT NULL
    COMMENT '해당 resource_type 잔액 갱신 전 값(감사 정본)' AFTER `balance_after`,
  ADD COLUMN `operator_id` INT NULL
    COMMENT '운영자 수동 거래(예치금 충전 등) 실행 운영자 user.id — 감사 정본' AFTER `balance_before`,
  ADD COLUMN `operator_email` VARCHAR(190) NULL
    COMMENT '운영자 수동 거래 실행 당시 운영자 email — 감사 정본' AFTER `operator_id`;

-- (2) 조회 인덱스 — 정산코드 예치금 이력(GET /settlement-codes/deposits) cursor 정렬(created_at, id) 대응.
--     type='CHARGE' AND resource_type='DEPOSIT' 필터가 wallet_account_id 로 좁혀지므로 account 인덱스로 충분하나,
--     운영자 감사 역조회를 위해 operator_id 보조 인덱스를 둔다.
ALTER TABLE `wallet_transaction`
  ADD INDEX `idx_wallet_tx_operator` (`operator_id`);

-- (3) 검증 — 신규 컬럼 분포(초기 전부 NULL 이 정상)
SELECT
  SUM(`operator_id` IS NOT NULL) AS with_operator,
  SUM(`balance_before` IS NOT NULL) AS with_balance_before,
  COUNT(*) AS total
FROM `wallet_transaction`;

-- (4) 롤백 (코드 롤백 후에만 실행)
-- ALTER TABLE `wallet_transaction` DROP INDEX `idx_wallet_tx_operator`;
-- ALTER TABLE `wallet_transaction`
--   DROP COLUMN `operator_email`,
--   DROP COLUMN `operator_id`,
--   DROP COLUMN `balance_before`;
