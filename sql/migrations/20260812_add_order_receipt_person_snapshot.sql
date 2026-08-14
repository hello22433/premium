-- 주문접수 담당자·회사·처리자 표시값 스냅샷 컬럼 추가
-- 애플리케이션 배포 전 실행한다. 기존 행 백필은
-- 20260812_backfill_order_receipt_person_snapshot.sql 을 신규 애플리케이션 배포 후 실행한다.
ALTER TABLE `order_receipt`
  ADD COLUMN `snapshot_person_name` VARCHAR(100) NULL COMMENT '[snapshot] 접수 등록 시점 담당자명',
  ADD COLUMN `snapshot_business_name` VARCHAR(100) NULL COMMENT '[snapshot] 접수 등록 시점 회사명',
  ADD COLUMN `snapshot_processed_person_name` VARCHAR(100) NULL COMMENT '[snapshot] 승인/반려 처리 시점 처리자명';
