-- 프리미엄 발송실패 추적·재발송 §9 「기존 경로 컷오버·마이그레이션 계약」 — canary 백필/전환 절차
-- 근거: plans/프리미엄_발송실패_재발송_구상.md §9(진입점 인벤토리·차단 방식·마이그레이션·롤백) / §10 2단계 PASS
-- ============================================================================
-- ⚠ 이 파일은 **자동 실행 마이그레이션이 아니다.** 대상 id 를 사람이 지정하고, 아래 순서대로
--   섹션별로 실행·검증하는 운영 절차서다. SECTION 0 의 대상 목록을 채우지 않으면 아무것도 바뀌지 않는다.
--
-- ⚠ 실행 전 필수 선행조건(둘 중 하나라도 미충족이면 전환하지 않는다):
--   (1) refund_attempt 실행기(§5.4)가 배포돼 있을 것.
--       전환 마크가 서는 순간 legacy 환불 진입점(#5~#9·#12)이 전부 거부되므로, 대체 실행기가 없으면
--       그 건의 환불이 막힌다. §9 acceptance 의 "대체 없는 진입점이 있으면 컷오버를 미룬다"에 해당.
--   (2) 발송 진입점의 legacy status 의존 제거(§9 HIGH 4)가 반영돼 있을 것.
--       전환 건의 order_delivery.status 는 workflow 파생 미러가 되는데, 현행 배치는 그 status 로
--       최초/재발송을 판별해 환불 보류 여부를 가른다. 그대로 전환하면 판별이 뒤집힌다.
--
-- 전환 마크는 플래그가 아니라 데이터 사실이다(delivery_workflow.cutover_migrated_at).
-- 마크가 서면 legacy 진입점은 DeliveryCutoverGuardService 가 409 DELIVERY_CUTOVER_LEGACY_BLOCKED 로 거부한다.
-- ============================================================================


-- ============================================================================
-- SECTION 0. canary 대상 지정
--   §10 2단계는 "최소 7일 관측"이므로 소수 건부터 전환한다. 대상은 사람이 명시 지정한다.
--   (조건식으로 대량 전환하지 않는다 — 되돌릴 수 없는 구간이 넓어진다.)
-- ============================================================================
DROP TEMPORARY TABLE IF EXISTS `cutover_target`;
CREATE TEMPORARY TABLE `cutover_target` (
  `order_delivery_id` INT NOT NULL,
  PRIMARY KEY (`order_delivery_id`)
) ENGINE=InnoDB;

-- 예시) 실제 canary id 로 교체한다. 비워두면 이후 섹션은 0건 처리로 안전하게 no-op 이다.
-- INSERT INTO `cutover_target` (`order_delivery_id`) VALUES (1001), (1002), (1003);


-- ============================================================================
-- SECTION 0-1. 선행 스키마 확인 (드레이닝 컬럼)
--   `20260728_add_delivery_workflow_cutover_draining.sql` 을 **코드 배포 전에** 적용했어야 한다.
--   아래가 1 이 아니면 이 runbook 을 진행하지 않는다(그 상태면 이미 가드·발송 라우팅이 실패 중이다).
-- ============================================================================
SELECT COUNT(*) AS has_cutover_draining_column
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'delivery_workflow'
   AND COLUMN_NAME  = 'cutover_draining_at';


-- ============================================================================
-- SECTION 1. quiesce — 드레이닝 마크 먼저 세운다 (admission race 차단)
--
--   ⚠ "진행 중 건이 없는지 확인한 뒤 전환 마크를 세운다"는 순서는 **안전하지 않다.**
--     확인과 전환 사이에, 이미 가드를 통과한 legacy 워커가 그 직후 lease 를 잡을 수 있다
--     (가드 통과 → 확인 쿼리 통과 → 마크 설정 → 워커가 claim). 그러면 전환 건에 legacy 와
--     신규 모델이 동시에 붙는다.
--
--   그래서 판정이 아니라 **진입 자체를 먼저 막는다.** 이 마크가 서는 순간부터
--   DeliveryCutoverGuardService 가 legacy 신규 진입을 거부하고(`DELIVERY_CUTOVER_LEGACY_BLOCKED`),
--   발송 라우팅도 `DELIVERY_CUTOVER_DRAINING` 으로 보류한다 — 양쪽 모두 정지한다.
--   앵커 행이 없으면 마크를 세울 수 없으므로 SECTION 2(앵커 백필)보다 먼저 앵커를 만든다.
-- ============================================================================
-- 1-a. 앵커가 없는 대상은 IN_PROGRESS 로 최소 생성한다(상태 매핑은 SECTION 2 에서 확정).
INSERT INTO `delivery_workflow` (`order_delivery_id`, `workflow_status`, `state_entered_at`)
SELECT od.id, 'IN_PROGRESS', NOW(6)
  FROM `order_delivery` od
  JOIN `cutover_target` t ON t.order_delivery_id = od.id
 WHERE NOT EXISTS (SELECT 1 FROM `delivery_workflow` w WHERE w.order_delivery_id = od.id);

-- 1-b. 드레이닝 마크. 조건 없이 세운다 — 진행 중이든 아니든 **신규 진입부터 막는 것이 목적**이다.
UPDATE `delivery_workflow` w
  JOIN `cutover_target` t ON t.order_delivery_id = w.order_delivery_id
   SET w.cutover_draining_at = NOW(6)
 WHERE w.cutover_draining_at IS NULL
   AND w.cutover_migrated_at IS NULL;


-- ============================================================================
-- SECTION 1-2. 배출 대기 후 잔여 확인
--
--   드레이닝 마크 이후에는 새 claim 이 성립하지 않는다 — 모든 legacy claim CAS 가 WHERE 에
--     NOT EXISTS (... dw.cutover_draining_at IS NOT NULL OR dw.cutover_migrated_at IS NOT NULL)
--   를 함께 싣기 때문이다(가드 통과 후 지연된 워커도 여기서 affected=0 이 된다).
--   따라서 남은 것은 **마크 직전에 이미 점유를 마친 작업**뿐이며, 이 확인은 수렴한다.
--   그 작업들이 끝나거나 lease 가 만료될 때까지 기다린 뒤 확인한다(대기는 배출용이지 원자성 근거가 아니다).
--
--   대기 시간 = max(legacy 최장 임계구간). 아래가 근거이며 **여유를 두고 10분 이상** 기다린다.
--     - claimedAt / mutation_claimed_at stale self-heal : 5분
--     - 협력사 발급 + Gemtek 발송 외부 호출 타임아웃    : 수십 초 ~ 수 분
--   대기 중에는 대상 건의 발송·환불이 모두 보류된다(canary 소수 건이라 영향 범위가 제한된다).
--
--   아래 두 쿼리가 **모두 0행**이어야 SECTION 3(전환)으로 간다.
--   0행이 아니면 더 기다린다. 계속 남으면 그 건을 대상에서 빼고(SECTION 5 로 드레이닝 해제) 조사한다.
-- ============================================================================
-- 1-2-a. legacy lease 잔여
SELECT od.id                AS order_delivery_id,
       od.status,
       od.claimed_at,
       od.mutation_claimed_at
  FROM `order_delivery` od
  JOIN `cutover_target` t ON t.order_delivery_id = od.id
 WHERE od.claimed_at IS NOT NULL
    OR od.mutation_claimed_at IS NOT NULL;

-- 1-2-b. 미종결 환불 in-flight (§9 환불 컷오버). SSG 복구 sweep 의 작업 대상이기도 하다.
SELECT r.order_delivery_id, r.ssg_balance_settled, r.ssg_recover_lease_until
  FROM `order_delivery_refund` r
  JOIN `cutover_target` t ON t.order_delivery_id = r.order_delivery_id
 WHERE r.ssg_balance_settled = 0;


-- ============================================================================
-- SECTION 2. workflow 상태 매핑 백필
--   전환 건의 SoT 는 delivery_workflow 다(§8 화면 SoT 고정).
--   앵커는 SECTION 1-a 에서 이미 만들었고, 여기서는 **초기 상태를 확정**한다.
--   드레이닝 구간이라 이 시점의 order_delivery.status 는 더 이상 변하지 않는다(legacy 진입 차단됨).
--   초기 상태 매핑(§9 마이그레이션):
--     - COMPLETE/COMPLETE_SMS            → COMPLETED          (전달 완료)
--     - CANCEL                           → CANCELLED
--     - FAIL/FAIL_SMS + barCode 있음      → FAILED_FINAL       (기존 PIN 재사용 가능 = MANUAL_RESEND 대상)
--     - FAIL/FAIL_SMS + barCode 없음      → OPS_REVIEW_REQUIRED(발급 여부 불명 → 운영 확인, 신규 발급 기본 금지)
--     - 그 외(WAIT 등)                    → IN_PROGRESS
--   ※ 이미 앵커가 있는 건(shadow 추적이 만든 행)은 건드리지 않는다.
-- ============================================================================
UPDATE `delivery_workflow` w
  JOIN `cutover_target` t ON t.order_delivery_id = w.order_delivery_id
  JOIN `order_delivery`  od ON od.id = w.order_delivery_id
   SET w.workflow_status =
         CASE
           WHEN od.status IN ('COMPLETE', 'COMPLETE_SMS') THEN 'COMPLETED'
           WHEN od.status = 'CANCEL'                      THEN 'CANCELLED'
           WHEN od.status IN ('FAIL', 'FAIL_SMS') AND od.bar_code IS NOT NULL AND od.bar_code <> ''
                                                          THEN 'FAILED_FINAL'
           WHEN od.status IN ('FAIL', 'FAIL_SMS')         THEN 'OPS_REVIEW_REQUIRED'
           ELSE 'IN_PROGRESS'
         END,
       w.state_entered_at = NOW(6),
       w.delivered_flag = CASE WHEN od.status IN ('COMPLETE', 'COMPLETE_SMS') THEN 1 ELSE 0 END,
       w.delivered_channel =
         CASE
           WHEN od.status = 'COMPLETE'     THEN od.delivery_method
           WHEN od.status = 'COMPLETE_SMS' THEN 'SMS'
         END,
       w.delivered_at = CASE WHEN od.status IN ('COMPLETE', 'COMPLETE_SMS') THEN od.actual_send_at END
 WHERE w.cutover_migrated_at IS NULL
   -- shadow 추적이 이미 하위 결과를 쌓아 상태를 계산해 둔 행은 덮지 않는다.
   AND w.workflow_status = 'IN_PROGRESS'
   AND NOT EXISTS (SELECT 1 FROM `message_attempt`   m WHERE m.order_delivery_id = w.order_delivery_id)
   AND NOT EXISTS (SELECT 1 FROM `pin_issue_command` c WHERE c.order_delivery_id = w.order_delivery_id);

-- OPS_REVIEW_REQUIRED 로 들어간 건은 에스컬레이션 SLA 기준 시각·사유를 채운다(§7.1).
UPDATE `delivery_workflow` w
  JOIN `cutover_target` t ON t.order_delivery_id = w.order_delivery_id
   SET w.ops_escalated_at = COALESCE(w.ops_escalated_at, NOW(6)),
       w.ops_review_reason = COALESCE(w.ops_review_reason, 'SLA_EXCEEDED')
 WHERE w.workflow_status = 'OPS_REVIEW_REQUIRED';


-- ============================================================================
-- SECTION 3. 전환 마크 세우기 (= 컷오버 flip)
--
--   SECTION 1-2 확인이 0행일 때만 실행한다. 드레이닝 마크가 이미 신규 진입을 막고 있으므로,
--   여기서의 잔여 확인은 "확인 후 새로 들어올 수 있는" 종류가 아니다 — 그게 quiesce 의 요점이다.
--   그래도 WHERE 에 잔여 조건을 그대로 남긴다: 대기 시간이 부족했을 때 조용히 전환되지 않게 한다.
--
--   `cutover_draining_at IS NOT NULL` 를 요구해 **드레이닝을 건너뛴 직접 전환을 금지**한다.
-- ============================================================================
UPDATE `delivery_workflow` w
  JOIN `cutover_target` t ON t.order_delivery_id = w.order_delivery_id
  JOIN `order_delivery`  od ON od.id = w.order_delivery_id
   SET w.cutover_migrated_at = NOW(6)
 WHERE w.cutover_migrated_at IS NULL
   AND w.cutover_draining_at IS NOT NULL          -- 드레이닝 선행 필수(quiesce 우회 금지)
   AND w.active_exclusive_op IS NULL
   AND od.claimed_at IS NULL
   AND od.mutation_claimed_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM `order_delivery_refund` r
      WHERE r.order_delivery_id = w.order_delivery_id AND r.ssg_balance_settled = 0
   );

-- 전환 결과 확인 — 대상 전부가 마크를 가져야 한다.
-- cutover_migrated_at 이 NULL 인 채 draining 만 있는 행 = 배출 미완. 더 기다렸다가 SECTION 3 재실행한다
-- (그 사이에도 그 건은 legacy·신규 양쪽 모두 정지 상태라 안전하다).
SELECT t.order_delivery_id,
       w.workflow_status,
       w.cutover_draining_at,
       w.cutover_migrated_at
  FROM `cutover_target` t
  LEFT JOIN `delivery_workflow` w ON w.order_delivery_id = t.order_delivery_id
 ORDER BY t.order_delivery_id;


-- ============================================================================
-- SECTION 4. 검증 (§10 2단계 PASS 항목 중 컷오버 관련분)
-- ============================================================================
-- 4-1. 전환 건에 legacy 점유가 새로 생기지 않는다 → 0 이어야 한다.
SELECT COUNT(*) AS legacy_claim_on_cutover
  FROM `delivery_workflow` w
  JOIN `order_delivery` od ON od.id = w.order_delivery_id
 WHERE w.cutover_migrated_at IS NOT NULL
   AND (od.claimed_at IS NOT NULL OR od.mutation_claimed_at IS NOT NULL);

-- 4-2. 슬롯 누수 0건.
SELECT COUNT(*) AS leaked_slots
  FROM `delivery_workflow`
 WHERE active_exclusive_op IS NOT NULL
   AND exclusive_lease_expires_at < NOW() - INTERVAL 1 HOUR;

-- 4-3. 전환 건의 미확정 환불이 2건 이상인 경우 0건(물리 unique 가 이미 막지만 확인용).
SELECT COUNT(*) AS multi_inflight_refund
  FROM (
    SELECT ra.order_delivery_id
      FROM `refund_attempt` ra
      JOIN `delivery_workflow` w ON w.order_delivery_id = ra.order_delivery_id
     WHERE w.cutover_migrated_at IS NOT NULL
       AND ra.status IN ('CLAIMED', 'SUBMITTING', 'RECONCILING', 'UNKNOWN')
     GROUP BY ra.order_delivery_id
    HAVING COUNT(*) > 1
  ) x;


-- ============================================================================
-- SECTION 5. 되돌리기
--
-- 5-a. **드레이닝 해제 (전환 전 단계 — 안전)**
--   SECTION 1-2 잔여가 계속 남아 전환을 포기할 때 쓴다. 아직 신규 모델을 시작한 적이 없으므로
--   legacy 로 그대로 돌려보내면 된다. 전환 마크가 이미 선 건은 대상에서 제외한다.
-- ============================================================================
-- UPDATE `delivery_workflow` w
--   JOIN `cutover_target` t ON t.order_delivery_id = w.order_delivery_id
--    SET w.cutover_draining_at = NULL
--  WHERE w.cutover_migrated_at IS NULL;

-- ============================================================================
-- 5-b. **전환 롤백 (§9 「단순 플래그 복귀 금지」)**
--   전환 상태 자체를 되돌리는 것은 **이중 처리로의 회귀**다. 원칙적으로 금지한다.
--   정상 롤백은 코드 레벨 emergency mode(신규 자동 발송·재발송만 중단, 추적·재조회·종결·정산 보류는 유지)로 한다.
--
--   아래 UPDATE 는 "전환 직후 아무 신규 작업도 일어나지 않았음이 확인된 경우"에만 쓰는 비상 수단이다.
--   조건: 해당 건에 message_attempt / pin_issue_command / refund_attempt 가 하나도 생기지 않았을 것.
--   드레이닝 마크는 남겨 quiesce 이력을 보존한다(다시 전환할 때 SECTION 3 를 바로 쓸 수 있다).
-- ============================================================================
-- UPDATE `delivery_workflow` w
--   JOIN `cutover_target` t ON t.order_delivery_id = w.order_delivery_id
--    SET w.cutover_migrated_at = NULL
--  WHERE w.active_exclusive_op IS NULL
--    AND NOT EXISTS (SELECT 1 FROM `message_attempt`     m WHERE m.order_delivery_id = w.order_delivery_id)
--    AND NOT EXISTS (SELECT 1 FROM `pin_issue_command`   c WHERE c.order_delivery_id = w.order_delivery_id)
--    AND NOT EXISTS (SELECT 1 FROM `refund_attempt`      r WHERE r.order_delivery_id = w.order_delivery_id);

DROP TEMPORARY TABLE IF EXISTS `cutover_target`;
