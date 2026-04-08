-- 발송 배치 중복 처리 방지를 위한 row-level claim 컬럼 추가
-- 배경: issueAndSend 배치가 30분 강제 리셋으로 겹쳐 돌며 같은 WAIT 행을 두 번 처리 → GIFTIEL 0227 중복 사고 발생
-- 해결: SELECT 전에 claimed_at을 NOW()로 UPDATE해서 이번 배치 몫을 원자적으로 클레임

-- DATETIME(6) 사용: JS Date의 ms 정밀도와 일치시켜 UPDATE→SELECT 클레임 매칭이 깨지지 않도록 함
ALTER TABLE order_delivery
  ADD COLUMN claimed_at DATETIME(6) NULL
    COMMENT '발송 배치 중복 처리 방지용 클레임 시각'
    AFTER failed_at;

-- issueAndSend UPDATE 패턴: WHERE status='WAIT' AND send_request_at < NOW() AND claimed_at IS NULL
CREATE INDEX idx_order_delivery_claim
  ON order_delivery (status, send_request_at, claimed_at);
