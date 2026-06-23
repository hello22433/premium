-- PR2 Wallet Cutover Bundle (PR2+PR3+PR4)
-- ALTER order_payment_allocation: released_at + release_reason
--
-- 목적:
--   OrderConfirmationReleaseService.releaseConfirmation() 보상 TX 의 결과를 allocation 레벨에 기록.
--   wallet-managed 후속 hook 의 routing predicate 는 다음을 사용:
--     EXISTS(allocation WHERE order_id = ? AND released_at IS NULL)
--   released_at IS NOT NULL 인 allocation 은 legacy path 로 회귀.
--
-- Plan 참조: .omc/plans/wallet-cutover-bundle-consensus-plan.md (F-001)
-- Spec 참조: .omc/specs/deep-interview-wallet-pr2-to-pr5-hook-strategy.md (Round 3 결정)
--
-- 적용 환경:
--   - MySQL 8.0.29+ (ALGORITHM=INPLACE + LOCK=NONE + ADD COLUMN IF NOT EXISTS 모두 지원)
--   - 사전에 다음 SQL 로 prod 호환성 확인:
--       SELECT VERSION();                                  -- 8.0.29 이상 보장
--       SELECT COUNT(*) FROM order_payment_allocation;     -- ALTER 영향 row 수 측정
--     예상 duration < 5min @ 1M rows (MySQL 8.0+ INPLACE).
--   - prod 적용 시 dry-run staging 에서 wall-clock duration 먼저 확인 후 prod 진입.
--
-- 적용 순서 (RUNBOOK):
--   1. staging dry-run: 본 SQL 실행 + 컬럼 존재 + NULL default 확인.
--   2. prod 적용: maintenance window 권장 (LOCK=NONE 이라 INSERT/UPDATE/SELECT 차단 없음).
--   3. 적용 후 backfill 불필요 (default NULL = "active wallet-managed", 신규 보상 시 채워짐).
--   4. 이후 PR2 wallet 활성화 RUNBOOK (legacy → shadow → wallet) 진입 가능.

ALTER TABLE `order_payment_allocation`
  ADD COLUMN IF NOT EXISTS `released_at` DATETIME(6) NULL DEFAULT NULL
    COMMENT 'OrderConfirmationReleaseService 가 보상 TX 로 allocation 을 무효화한 시각. NULL = active wallet-managed.',
  ADD COLUMN IF NOT EXISTS `release_reason` VARCHAR(200) NULL DEFAULT NULL
    COMMENT '보상 사유 (external API timeout / message enqueue failed / manual rollback 등). released_at 갱신 시 같이 채움.',
  ALGORITHM=INPLACE,
  LOCK=NONE;

-- routing predicate 가 EXISTS(allocation WHERE order_id=? AND released_at IS NULL) 패턴을 자주 쓰므로
-- (order_id, released_at) 부분 인덱스 후보. 그러나 PR1 UNIQUE(order_id) 가 이미 order_id 단일 lookup 을 보장하고
-- released_at 추가 필터링은 row 1 건 read 후 평가 (성능 영향 미미). 별도 인덱스 미생성.

-- =====================================================================
-- ROLLBACK SQL (운영자 수동 실행, 본 plan 범위 밖)
-- =====================================================================
-- 본 ALTER 적용 후 wallet-managed 주문이 prod 에 1건이라도 생성됐다면
-- 컬럼 DROP 시 데이터 손실 발생 → 운영자가 명시적으로 결정해야 함.
--
-- 안전 rollback (PR2 prod wallet 미활성화 시점에만 가능):
--   ALTER TABLE `order_payment_allocation`
--     DROP COLUMN IF EXISTS `released_at`,
--     DROP COLUMN IF EXISTS `release_reason`,
--     ALGORITHM=INPLACE,
--     LOCK=NONE;
--
-- PR2 prod wallet 활성화 후 rollback 은 권장하지 않음.
-- 필요 시 .omc/plans/wallet-cutover-bundle-consensus-plan.md
-- ADR Consequences + RUNBOOK manual recovery 절차 참조.
