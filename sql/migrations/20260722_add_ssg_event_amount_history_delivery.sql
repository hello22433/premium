-- ssg_event_amount_history 에 차감 귀속 발송건 추가 (197-16 예약건 부분취소)
--
-- ┌─ 실행 순서 ────────────────────────────────────────────────────────────────┐
-- │ (0) 사전 확인  → 이미 적용됐는지 본다. 적용돼 있으면 (1)(2)를 건너뛴다.     │
-- │ (1) 컬럼 추가                                                              │
-- │ (2) 인덱스 추가   ← (1) 이 먼저여야 한다. 없는 컬럼에는 인덱스를 못 건다.   │
-- │ 그 다음: 애플리케이션 배포                                                 │
-- └────────────────────────────────────────────────────────────────────────────┘
-- ※ 이 파일과 20260722_add_order_delivery_cancel_reason.sql 사이에는 순서 의존이 없다
--   (다른 테이블). 다만 둘 다 앱 배포보다 먼저 적용돼야 한다 — 엔티티가 두 컬럼을 선언하므로
--   컬럼 없이 앱이 뜨면 해당 테이블을 읽는 조회가 Unknown column 으로 전부 실패한다.
--
-- 배경: 행사잔액 차감 이력은 (행사 1개 = 1행) 으로 뭉쳐 저장된다.
--       deductEventBalanceMultiple 은 호출부에서 발송건별 { deliveryId, eventId, price } 를
--       이미 받고 있으나, 이력을 쓸 때 eventId 로 합산하며 deliveryId 를 버린다.
--       그 결과 "이 발송건이 얼마를 차감했는지" 를 이력만으로는 알 수 없어,
--       주문 일부만 취소해도 행사잔액을 전액 복구할 수밖에 없다(과다 복구).
-- 해결: 버리던 deliveryId 를 이력행에 남긴다. 새로 계산하는 값이 아니라 이미 있는 값을 저장할 뿐이다.
--
-- ※ 이 마이그레이션은 컬럼만 만든다. 값을 채우는 코드는 아직 없다 —
--   deductEventBalanceMultiple 이 여전히 행사 단위로 합산해 1행만 남기므로,
--   적용 직후에는 신규 행도 전부 NULL 이다. 기록/부분복구/차단 가드는 모두 후속 커밋 범위다.
--   (행사 단위 합산을 발송건 단위로 분해해야 해서 한 줄짜리 변경이 아니다.)
--
-- 백필: 하지 않는다. 과거 이력은 발송건별 금액을 복원할 근거가 없고,
--       비율 안분은 실제 차감액과 어긋날 수 있다(행사잔액은 상한 검증이 없어 부풀면 되돌리기 어렵다).
--       대신 귀속이 없는(NULL) 주문은 부분취소를 애플리케이션에서 차단하고 전체취소로 안내할 예정이다.


-- (0) 사전 확인 — 아래 두 쿼리가 0건이면 미적용 상태다. 1건이면 그 단계를 건너뛴다.
--     (ADD COLUMN IF NOT EXISTS 는 MariaDB 전용이라 쓰지 않는다. 엔진 무관하게 확인하기 위함.)
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'ssg_event_amount_history'
   AND COLUMN_NAME = 'order_delivery_id';

SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'ssg_event_amount_history'
   AND INDEX_NAME = 'idx_ssg_amount_history_order_delivery'
 ORDER BY SEQ_IN_INDEX;


-- (1) 컬럼 추가
--     ★ (2) 와 반드시 분리한다. ADD COLUMN 단독이면 INSTANT 로 처리되지만(MySQL 8.0.29+),
--       인덱스 추가와 한 문장에 섞으면 INSTANT 가 선택될 수 없어 테이블 전체가 리빌드된다.
--       발송건당 1행씩 쌓일 이력 테이블이라 리빌드 시간이 무시 못 될 수 있다. 다시 합치지 말 것.
ALTER TABLE `ssg_event_amount_history`
  ADD COLUMN `order_delivery_id` INT NULL
    COMMENT 'FK) order_delivery.id — 차감 귀속 발송건 (부분복구용). NULL=기록 도입 이전 데이터 또는 발송건 무관 변동(충전/재발송 선차감 등)'
    AFTER `order_id`;


-- (2) 조회 인덱스 — (1) 이후에 실행한다.
--     복합 (order_id, order_delivery_id):
--       · 부분복구: order_id = ? AND order_delivery_id IN (...)
--       · 전체복구: order_id 단독 조회도 leftmost prefix 로 커버된다.
--     ※ 이 테이블에 order_id 인덱스가 있는지는 운영 DB 에서 (0) 으로 확인할 것.
--       로컬(MariaDB)에서는 PRIMARY 외 인덱스가 없어 기존 restoreEventBalance 의
--       where { orderId } 조회가 풀스캔이었다. 운영도 같다면 이 인덱스가 그 조회까지 개선한다.
CREATE INDEX `idx_ssg_amount_history_order_delivery`
    ON `ssg_event_amount_history` (`order_id`, `order_delivery_id`);


-- (3) 롤백 — 적용의 역순이다. 코드(엔티티) 롤백을 먼저 끝낸 뒤에만 실행할 것.
--     엔티티가 컬럼을 선언한 채로 컬럼을 지우면 조회가 전부 깨진다.
-- DROP INDEX `idx_ssg_amount_history_order_delivery` ON `ssg_event_amount_history`;
-- ALTER TABLE `ssg_event_amount_history` DROP COLUMN `order_delivery_id`;
