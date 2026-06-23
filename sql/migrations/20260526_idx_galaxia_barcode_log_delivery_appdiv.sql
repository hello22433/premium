-- galaxia_barcode_log (order_delivery_id, app_div) 복합 인덱스 추가
-- 감사 findings-담당3 MEDIUM-4 보강
--
-- 배경: 갤럭시아 INACTIVE(환불/만료) 구분 로직이
--   existsBy({ orderDeliveryId, appDiv: '81' }) → SELECT 1 FROM galaxia_barcode_log
--   WHERE order_delivery_id = ? AND app_div = ? LIMIT 1
-- 형태로 조회한다. 두 컬럼 모두 인덱스가 없어 야간 batch에서 INACTIVE 건마다 full scan이 발생.
-- 데이터가 누적될수록 batch가 느려지는 위험을 복합 인덱스로 제거한다.
--
-- 참고: src/entity/galaxia.barcode.log.entity.ts 의 @Index(['orderDeliveryId', 'appDiv']) 와 대응.
--   (TypeORM auto-migration 미사용 프로젝트이므로 운영 DB 인덱스는 본 SQL로 별도 생성한다.)

CREATE INDEX idx_galaxia_barcode_log_delivery_appdiv
  ON galaxia_barcode_log (order_delivery_id, app_div);
