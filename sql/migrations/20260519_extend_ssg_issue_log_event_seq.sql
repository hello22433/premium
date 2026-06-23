-- ssg_issue_log 컬럼 추가 (orphan resolver check() 호출 파라미터 완성)
-- plans/ssg-balance-refactor.md PR2
--
-- SSG check API는 (eventNo, eventSeq, vno=personalCode) 3개 파라미터를 요구한다.
-- 기존 log row는 event_no 만 가지고 있어 orphan resolver가 check() 호출을 완성할 수 없다.
-- 이 마이그레이션은 PR2 본작업 전 PR1 schema 보정 (리뷰 finding HIGH).
--
-- 새 컬럼:
--   - event_seq INT NULL    : SSG 행사 순번 (ssg_event.order)
--   - ssg_event_id INT NULL : ssg_event FK (legacy row 호환 위해 NULL 허용, PR2 신규 row는 NOT NULL value 강제)
--
-- 기존 row는 두 컬럼 모두 NULL 상태로 남는다. orphan resolver는 NULL인 후보 row는 skip한다.

ALTER TABLE ssg_issue_log
  ADD COLUMN event_seq INT NULL COMMENT 'SSG 행사 순번 (ssg_event.order, check() 파라미터)'
    AFTER event_no,
  ADD COLUMN ssg_event_id INT NULL COMMENT 'FK) ssg_event.id (orphan resolver 복원용)'
    AFTER event_seq,
  ADD INDEX idx_ssg_issue_log_order_delivery_id (order_delivery_id);
