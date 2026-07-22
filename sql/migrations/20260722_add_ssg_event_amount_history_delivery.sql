-- ssg_event_amount_history 에 차감 귀속 발송건 추가 (197-16 예약건 부분취소)
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

ALTER TABLE ssg_event_amount_history
  ADD COLUMN order_delivery_id INT NULL
    COMMENT 'FK) order_delivery.id — 차감 귀속 발송건 (부분복구용). NULL=백필 이전 데이터 또는 발송건 무관 변동(충전/재발송 선차감 등)'
    AFTER order_id,
  -- (order_id, order_delivery_id) 복합 인덱스.
  --  · 부분복구: order_id + order_delivery_id IN (...) 조회
  --  · 전체복구: order_id 단독 조회도 leftmost prefix 로 커버 (기존엔 인덱스가 없어 풀스캔이었다)
  ADD INDEX idx_ssg_amount_history_order_delivery (order_id, order_delivery_id);
