-- 외부 환불 콜백의 "실제 종료" 를 durable 사실로 남긴다(§6.1 fencing 한계 대응).
--
-- hard timeout 은 워커를 대기에서 벗어나게 할 뿐 JS Promise 를 취소하지 못한다. 그래서
-- 상태(UNKNOWN/RECONCILING)·경과시간·stale 감사 행은 어느 것도 "콜백이 끝났다" 의 근거가 아니다.
-- 근거 없이 미실행(FAILED)을 확정하면, 살아남은 콜백이 뒤늦게 실제 환불을 커밋했을 때
-- attempt 만 FAILED 가 되어 신규 attempt 가 열린다(이중 환불).
--
-- 기록 주체는 콜백을 실제로 관측한 프로세스뿐이다.
--   - timeout 이 아닌 종료(정상 응답·예외) → settle/stale 트랜잭션에서 함께 기록
--   - timeout 종료 → 살아남은 promise 가 나중에 종결될 때 별도 트랜잭션으로 기록
-- 프로세스가 timeout 구간에서 죽으면 이 값은 끝내 NULL 로 남고, 해당 attempt 는 FAILED 로
-- 자동 확정되지 않고 재조정 SLA 초과 후 UNKNOWN → 운영 수동 종결로 간다(fail-safe, §5.4).
--
-- attempt 1건당 외부 환불 호출은 1회다(재시도는 새 attempt 행). 따라서 값의 존재 자체가 정지 근거이며,
-- 세대를 담는 이유는 "어느 실행이 끝났는지" 를 감사에서 특정하기 위해서다.
-- 기존 행은 NULL 이고, 이미 종결(SUCCEEDED/FAILED)된 행은 이 값을 보지 않는다.

ALTER TABLE `refund_attempt`
  ADD COLUMN `execution_quiesced_generation` BIGINT NULL
    COMMENT '외부 환불 콜백이 실제 종료된 세대. NULL=in-flight 가능 → FAILED 확정 금지(§6.1)';

-- 검증
-- SELECT id, status, generation, execution_quiesced_generation, failure_reason
--   FROM refund_attempt
--  WHERE status IN ('SUBMITTING', 'RECONCILING', 'UNKNOWN')
--    AND execution_quiesced_generation IS NULL;
-- 기대: 여기 남는 행은 재조정이 FAILED 를 확정하지 않고 운영 종결로 넘기는 건들
