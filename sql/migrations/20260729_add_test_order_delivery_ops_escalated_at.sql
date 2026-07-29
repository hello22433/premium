-- 테스트 발송 확정 실패 잔류 건의 운영 확인 마킹.
-- testDelivery 는 TEMP 저장 → WAIT 전환 → oneSend → COMPLETE 확정 순으로 동작한다.
-- 발송은 성공했는데 확정 UPDATE 가 실패하면 WAIT 로 잔류하고, 성공 이력 조회(COMPLETE/COMPLETE_SMS)에서
-- 빠져 화면에 노출되지 않는다(횟수는 소진된 상태 유지 — 중복 발송 방지). 이 건을 운영이 인지할 수 있도록
-- 1회만 경보하고 조회 가능하게 마킹한다.
-- provider 도달 여부를 알 수 없어 자동 확정(COMPLETE)은 하지 않는다. 미발송 건을 성공으로 표시하게 되기 때문이다.

-- (1) 컬럼 추가 (NULL 허용; 기존 행은 전부 COMPLETE 라 대상 없음 — 백필 불필요)
ALTER TABLE `test_order_delivery`
  ADD COLUMN `ops_escalated_at` DATETIME NULL
    COMMENT '발송 여부 불명(WAIT) 잔류 경보 시각. NOT NULL 이면 이미 경보한 건이라 중복 경보하지 않는다' AFTER `deleted_at`;

-- (2) 조회 인덱스 — 잔류 후보 조회(status + created_at)와 운영 미해결 건 역조회에 사용한다.
ALTER TABLE `test_order_delivery`
  ADD INDEX `idx_test_order_delivery_status_created` (`status`, `created_at`);

-- (3) 검증 — 신규 컬럼 분포(초기 전부 NULL 이 정상), 상태 분포
SELECT
  SUM(`ops_escalated_at` IS NOT NULL) AS escalated,
  COUNT(*) AS total
FROM `test_order_delivery`;

SELECT `status`, COUNT(*) AS cnt
FROM `test_order_delivery`
GROUP BY `status`;

-- (4) 롤백 (코드 롤백 후에만 실행)
-- ALTER TABLE `test_order_delivery` DROP INDEX `idx_test_order_delivery_status_created`;
-- ALTER TABLE `test_order_delivery` DROP COLUMN `ops_escalated_at`;
