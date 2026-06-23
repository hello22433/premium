-- order_delivery에 환불 발생 시각 컬럼 추가 (빠른 조회 보조 플래그)
-- 환불 자체의 멱등성은 order_delivery_refund 테이블 UNIQUE 제약이 보장한다.
-- refunded_at은 발송건 조회 시 JOIN 없이 환불 여부를 즉시 확인하기 위한 보조 컬럼.
-- 발송실패 후 재발송 성공 시 NULL로 복귀 → 재실패 시 다시 환불 가능 상태.

ALTER TABLE order_delivery
  ADD COLUMN refunded_at DATETIME(6) NULL
    COMMENT '환불 발생 시각 (NULL=미환불)'
    AFTER discarded_at;
