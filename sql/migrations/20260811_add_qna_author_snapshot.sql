-- EP_P25 Task C: QnA 작성자 담당자명·회사명 스냅샷 컬럼 추가
-- 애플리케이션 배포 전 실행한다. 기존 행 백필은
-- 20260811_backfill_qna_author_snapshot.sql을 신규 애플리케이션 배포 후 실행한다.
ALTER TABLE `qna`
  ADD COLUMN `snapshot_person_name` VARCHAR(100) NULL COMMENT '[snapshot] 문의 작성 시점 담당자명',
  ADD COLUMN `snapshot_business_name` VARCHAR(100) NULL COMMENT '[snapshot] 문의 작성 시점 회사명';
