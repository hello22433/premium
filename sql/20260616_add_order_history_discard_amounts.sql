-- order_history 에 폐기/복원 금액 구조화 컬럼 추가.
-- 변경이력(execStatusList) 응답에서 행별 폐기·복원 금액을 content 문자열 파싱 없이
-- 구조화 필드로 제공하기 위함. 다건 폐기/복원 시 행별 금액 정확도 확보.
--
-- 정의:
--   destroy_amount : 그 폐기 행에서 폐기된 정산금액(할인가 기준, calculateSettlementPrice).
--                    폐기/환불폐기 이력만 채움.
--   restore_amount : 실제로 잔액/여신/예치금으로 복원된 금액.
--                    이미 환불됨(ledger exists)/REFUND_CANCEL/복구 skip 시 NULL.
-- 과거 row 는 NULL 유지(프론트는 값이 있으면 구조화 필드 사용, 없으면 기존 폴백).

-- (1) 컬럼 추가 (NULL 허용)
ALTER TABLE `order_history`
  ADD COLUMN `destroy_amount` INT NULL
    COMMENT '폐기 시 폐기 대상 정산금액(할인가 기준). 폐기/환불폐기 이력만 채움. NULL=해당없음/레거시'
    AFTER `after_change`,
  ADD COLUMN `restore_amount` INT NULL
    COMMENT '폐기 시 실제 잔액/여신/예치금으로 복원된 금액. 이미 환불/복구 skip 시 NULL. NULL=해당없음/레거시'
    AFTER `destroy_amount`;

-- (2) 백필 없음 — content 문자열 파싱은 하지 않는다(부정확). 과거 row 는 NULL 유지.

-- (3) 검증
-- 컬럼 추가 확인
SHOW COLUMNS FROM `order_history` LIKE '%_amount';

-- (4) 롤백 (코드 롤백 후에만 실행)
-- ALTER TABLE `order_history`
--   DROP COLUMN `destroy_amount`,
--   DROP COLUMN `restore_amount`;
