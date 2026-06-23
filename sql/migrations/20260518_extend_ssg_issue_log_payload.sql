-- ssg_issue_log 컬럼 확장 (orphan resolver payload durable 저장)
-- plans/ssg-balance-refactor.md PR1
--
-- ATTEMPTED state에서 orphan resolver가 SSG check API로 PIN 등록 여부 확인 후,
-- 등록된 PIN을 우리 DB에 복원할 때 필요한 필드:
--   - expire_at, encourage_at: 발송 메타 (issue() 호출 직전 결정된 값)
--   - coupon_num: 외부 협력사 코드 (SSG가 발급하는 쿠폰 식별자)
-- bar_code / personal_code / ssg_transaction_id / event_no는 이미 존재.
-- 새 컬럼은 모두 nullable로 두어 기존 row는 영향 없음.

ALTER TABLE ssg_issue_log
  ADD COLUMN expire_at DATETIME NULL COMMENT 'order_delivery.expire_at (orphan 복원용)'
    AFTER inserted_at,
  ADD COLUMN encourage_at DATETIME NULL COMMENT 'order_delivery.encourage_at (orphan 복원용)'
    AFTER expire_at,
  ADD COLUMN coupon_num VARCHAR(100) NULL COMMENT 'order_delivery.coupon_num (orphan 복원용)'
    AFTER encourage_at;
