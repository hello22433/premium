-- order_delivery 에 발송건 단위 취소 사유/시각 추가 (197-16 예약건 부분취소)
-- 배경: 취소 사유는 order.cancel_reason / order.canceled_at 에만 있어 주문 단위다.
--       부분취소는 한 주문에서 여러 번 발생할 수 있어(상품행별 예약시각이 다름),
--       주문 단위 컬럼만 쓰면 마지막 취소 사유가 앞선 사유를 덮어쓴다.
-- 해결: 발송건마다 사유/시각을 남긴다. 주문 단위 컬럼은 전체취소용으로 그대로 유지한다.
-- 백필: 하지 않는다. 기존 취소 건은 주문 전체 취소이므로 order.cancel_reason 이 이미 정확하다.

ALTER TABLE order_delivery
  ADD COLUMN canceled_at DATETIME(6) NULL
    COMMENT '발송건 취소 시각 (부분취소). NULL=미취소'
    AFTER discarded_at,
  -- order.cancel_reason 은 text 지만 여기는 varchar(1000) 로 둔다.
  -- 요청 DTO 가 @MaxLength(1000) 으로 이미 제한하고 있어 저장 한도를 스키마에 명시한다.
  ADD COLUMN cancel_reason VARCHAR(1000) NULL
    COMMENT '발송건 취소 사유 (부분취소)'
    AFTER canceled_at;
