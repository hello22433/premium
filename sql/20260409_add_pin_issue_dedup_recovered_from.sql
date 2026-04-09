-- PIN 발급 dedup 테이블에 recovered_from 컬럼 추가
-- 배경: 1단계(pin_issue_dedup + conflict throw)에 recovery 경로를 덧붙이면서,
--       어느 경로로 PIN을 복구했는지 감사/통계 목적으로 기록한다.
-- 값 정의:
--   FRESH_ISSUE - 협력사에 실제 요청해서 새로 발급 (기본값, 대부분의 row)
--   DEDUP       - 동시 경쟁 상황에서 다른 트랜잭션의 PIN을 그대로 이어받음
--   CHECK_API   - (향후 확장) 협력사 상태 조회 API로 복구
--   HISTORY_LOG - (향후 확장) 응답 로그 파싱으로 복구
-- 현재 2단계 구현에서는 FRESH_ISSUE / DEDUP 두 값만 실제 사용한다.

ALTER TABLE pin_issue_dedup
  ADD COLUMN recovered_from ENUM('DEDUP','CHECK_API','HISTORY_LOG','FRESH_ISSUE')
    NOT NULL DEFAULT 'FRESH_ISSUE'
    COMMENT 'PIN 복구 경로 (감사용)'
    AFTER bar_code;
