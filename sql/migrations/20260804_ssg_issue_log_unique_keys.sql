-- ssg_issue_log 후보 PIN 생애 유일성 제약
-- docs/plans/2026-08-04-ssg-issue-log-unique-typed-collision.md
--
-- 기존: idx_ssg_issue_log_bar_code / idx_ssg_issue_log_personal_code (non-unique)
-- 변경: uq_ssg_issue_log_bar_code / uq_ssg_issue_log_personal_code (UNIQUE)
--
-- 발급 경로의 로컬 중복 검사는 SELECT 후 INSERT 라 비원자적이고, withSsgMutex 는 프로세스 로컬이라
-- 다중 노드에서 무효하다. SSG Oracle 측에도 unique 제약이 없다. 따라서 후보 PIN 유일성의 권위는
-- 이 제약뿐이다. 위반은 애플리케이션에서 SsgIssueLogKeyCollisionError 로 승격되어 다음 후보로 진행한다.
--
-- 선행 조건 (반드시):
--   1) 애플리케이션에 typed 충돌 분류가 이미 배포되어 있을 것.
--      먼저 이 DDL 이 들어가면 raw QueryFailedError 가 일반 실패로 뭉개지거나 기존 PIN 복구 분기로
--      오진입해 다른 고객의 PIN 이 발송 건에 부착될 수 있다.
--   2) sql/ops/PREFLIGHT-ssg-issue-log-unique.md 의 중복 검사가 0행일 것.
--      중복이 있으면 아래 ALTER 가 1062 로 실패한다. 이것은 의도된 동작이다.
--      로그는 orphan 복구의 진실 원천이므로 이 마이그레이션은 어떤 행도 삭제하지 않는다.

-- 프리플라이트 (실행 전 확인, 두 쿼리 모두 0행이어야 한다)
--   SELECT bar_code, COUNT(*), COUNT(DISTINCT order_delivery_id)
--     FROM ssg_issue_log GROUP BY bar_code HAVING COUNT(*) > 1;
--   SELECT personal_code, COUNT(*), COUNT(DISTINCT order_delivery_id)
--     FROM ssg_issue_log GROUP BY personal_code HAVING COUNT(*) > 1;

-- ALGORITHM/LOCK 을 명시하는 이유는 속도가 아니라 안전장치다. 보조 인덱스 추가·삭제는 InnoDB 에서
-- 테이블을 재구성하지 않고 동시 DML 을 허용한다. in-place 가 불가능한 상황이면 MySQL 이 조용히
-- COPY 알고리즘으로 떨어져 쓰기를 막는 대신 이 문장이 즉시 실패한다.
-- 실패하면 원인을 확인한 뒤 두 절을 빼고 점검 창에서 재시도한다.
ALTER TABLE ssg_issue_log
  DROP INDEX idx_ssg_issue_log_bar_code,
  DROP INDEX idx_ssg_issue_log_personal_code,
  ADD UNIQUE INDEX uq_ssg_issue_log_bar_code (bar_code),
  ADD UNIQUE INDEX uq_ssg_issue_log_personal_code (personal_code),
  ALGORITHM=INPLACE, LOCK=NONE;

-- 적용 확인
--   SHOW INDEX FROM ssg_issue_log;
--   → uq_ssg_issue_log_bar_code / uq_ssg_issue_log_personal_code 가 Non_unique=0 으로 존재

-- 롤백 (제약 자체는 롤백 대상이 아니다. 긴급 시에만 사용하고 재도입 계획을 함께 세운다)
--   ALTER TABLE ssg_issue_log
--     DROP INDEX uq_ssg_issue_log_bar_code,
--     DROP INDEX uq_ssg_issue_log_personal_code,
--     ADD INDEX idx_ssg_issue_log_bar_code (bar_code),
--     ADD INDEX idx_ssg_issue_log_personal_code (personal_code),
--     ALGORITHM=INPLACE, LOCK=NONE;
