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

-- (2) 한도 선점 여부 컬럼 추가
-- 테스트 발송 횟수 제한(order_product_mapping.test_delivery_count)은 기업관리자에게만 적용된다.
-- 운영/최고관리자 발송은 무제한이라 카운트를 증가시키지 않으므로, 잔류 정리 시 회수 대상에서도 빠져야 한다.
-- 이 값이 0 이면 "카운트를 올리지 않은 건" 이라 되돌릴 한도도 없다.
-- 기존 행은 전부 카운트를 올린 건이라 DEFAULT 1 로 현재 동작이 그대로 유지된다(백필 불필요).
ALTER TABLE `test_order_delivery`
  ADD COLUMN `limit_claimed` TINYINT(1) NOT NULL DEFAULT 1
    COMMENT '한도(test_delivery_count) 선점 건 여부. 운영/최고관리자 발송은 0 — 잔류 정리 시 한도 회수 대상에서 제외' AFTER `ops_escalated_at`;

-- (2-1) 발송 성공 확정 시각 컬럼 추가
-- 이 기능 이전 구현은 oneSend 호출 '전' 에 status=COMPLETE 로 저장하고 발송 실패 시에도 행을 지우지 않았다.
-- 그래서 기존 COMPLETE 행에는 실패 건이 섞여 있고, status 만으로는 성공/실패를 구분할 수 없다.
-- 주문 상세의 테스트 발송 이력은 이번에 새로 노출되는 화면이므로, 확정 시각이 찍힌 건(신규 흐름에서
-- 발송 성공 후 COMPLETE 로 전이한 건)만 성공 이력으로 보여준다.
-- 기존 행은 전부 NULL 로 남아 노출되지 않는다(성공 여부 판정 불가 → 노출 금지). 백필하지 않는다.
ALTER TABLE `test_order_delivery`
  ADD COLUMN `confirmed_at` DATETIME NULL
    COMMENT '발송 성공 확정 시각. NULL 이면 확정 전이거나 성공 여부 판정 불가한 legacy 행이라 이력 미노출' AFTER `limit_claimed`;

-- (3) 조회 인덱스 — 잔류 후보 조회와 주문 상세의 이력 조회에 사용한다.
-- 두 경로 모두 order_product_mapping_id 로 먼저 좁힌 뒤 status 로 거르므로 선행 컬럼을 그에 맞춘다.
--   - 잔류 정리: order_product_mapping_id + status(TEMP/WAIT) + created_at(grace 경과)
--   - 주문 상세: order_product_mapping_id IN (...) + status(COMPLETE/COMPLETE_SMS) + confirmed_at IS NOT NULL
-- created_at 은 잔류 정리의 grace 비교에 쓰이므로 후행에 둔다.
ALTER TABLE `test_order_delivery`
  ADD INDEX `idx_test_order_delivery_mapping_status_created` (`order_product_mapping_id`, `status`, `created_at`);

-- (4) 검증 — 신규 컬럼 분포(escalated 는 초기 전부 NULL, limit_claimed 는 초기 전부 1 이 정상), 상태 분포
SELECT
  SUM(`ops_escalated_at` IS NOT NULL) AS escalated,
  SUM(`limit_claimed` = 1) AS limit_claimed,
  SUM(`confirmed_at` IS NOT NULL) AS confirmed,
  COUNT(*) AS total
FROM `test_order_delivery`;

SELECT `status`, COUNT(*) AS cnt
FROM `test_order_delivery`
GROUP BY `status`;

-- (5) 롤백 (코드 롤백 후에만 실행)
-- ALTER TABLE `test_order_delivery` DROP INDEX `idx_test_order_delivery_mapping_status_created`;
-- ALTER TABLE `test_order_delivery` DROP COLUMN `confirmed_at`;
-- ALTER TABLE `test_order_delivery` DROP COLUMN `limit_claimed`;
-- ALTER TABLE `test_order_delivery` DROP COLUMN `ops_escalated_at`;
