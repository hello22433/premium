-- order_delivery에 폐기/환불폐기 시각을 정확히 기록하기 위한 컬럼 추가
-- 배경: 정산 partner-company 엑셀 다운로드의 "폐기시간" 컬럼이 updated_at을 사용하고 있어,
--       폐기 이후 다른 컬럼이 갱신되면 잘못된 시각이 표시되는 문제가 있음.
-- 해결: discarded_at 컬럼을 추가하고 execDiscard 트랜잭션 내에서 세팅. 환불폐기도 동일 컬럼 사용
--       (refund_at은 "환불금 입금 완료 일자"로 별도 운영자 입력 값이라 의미가 다름)

ALTER TABLE order_delivery
  ADD COLUMN discarded_at DATETIME NULL
    COMMENT '폐기/환불폐기 시각'
    AFTER claimed_at;

-- 백필 1단계: order_history 기반 (정확한 폐기 시각)
UPDATE order_delivery od
SET discarded_at = (
  SELECT MAX(oh.created_at)
  FROM order_history oh
  WHERE oh.order_delivery_id = od.id
    AND oh.type IN ('폐기', '환불폐기')
)
WHERE od.coupon_status IN ('CANCEL', 'REFUND_CANCEL')
  AND od.discarded_at IS NULL;

-- 백필 2단계: history 미기록 잔여 건은 updated_at 폴백 (현재 엑셀이 쓰던 값과 동일)
UPDATE order_delivery
SET discarded_at = updated_at
WHERE coupon_status IN ('CANCEL', 'REFUND_CANCEL')
  AND discarded_at IS NULL;
