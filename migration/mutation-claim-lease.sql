-- Mutation Claim Lease Migration (D3-55 후속: 재발행 진행중 잠금)
-- 실행 시점: 코드 배포 전 (컬럼이 없으면 기동 시 Unknown column 으로 전면 장애)
--
-- 용도: 쿠폰상태 변형 작업(폐기/외부취소/재발행)의 진행중 lease.
--   - 발송배치용 claimed_at 과 반드시 별개 컬럼이어야 한다:
--     (1) claimed_at 은 status 파티션별 stale 정책이 다르다(배치 WAIT=stale 없음 / 재발송=5분).
--         폐기·취소는 status 를 가로지르므로 같은 컬럼을 쓰면 배치의 활성 claim 을 stale 강탈하게 된다.
--     (2) 부팅 sweep(releaseStaleBatchClaims)이 WAIT+claimed_at 을 무조건 NULL 로 밀어
--         재발행 tip 의 살아있는 점유가 치워진다.
--   - 획득: UPDATE ... SET mutation_claimed_at=:now
--           WHERE (mutation_claimed_at IS NULL OR mutation_claimed_at < :now-5분)  -- CAS + self-heal
--   - 쓰기: WHERE id=:id AND mutation_claimed_at=:my  -- fencing (좀비 차단)
--   - 해제: finally 에서 owner guard 조건부
--
-- ⚠️ MySQL 8.0: nullable 컬럼 추가는 ALGORITHM=INSTANT (무중단).
--    MySQL 5.7: 테이블 재작성 발생 — 적용 전 버전·행수 확인 필수.

ALTER TABLE `order_delivery` ADD COLUMN `mutation_claimed_at` DATETIME(6) NULL
  COMMENT '쿠폰상태 변형(폐기/취소/재발행) 진행중 lease. 발송배치용 claimed_at 과 별개' AFTER `claimed_at`;
