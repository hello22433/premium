-- 경로 B(종결 상태 환불) 가 UNKNOWN 으로 workflow 를 OPS_REVIEW_REQUIRED 로 승격한 뒤,
-- 재조정으로 결과가 확정되면 원래 종결 상태로 되돌리기 위한 복원 기준(§5.4).
-- 이 값이 없으면 "환불 성공 확정 + workflow 는 계속 환불 결과 불명" 상태가 남는다.
-- 기존 행은 NULL 이며 복원 대상이 아니다(승격 해제는 우리가 올린 REFUND_UNKNOWN 일 때만 수행).

ALTER TABLE `refund_attempt`
  ADD COLUMN `entry_workflow_status` VARCHAR(32) NULL
    COMMENT '환불 시작 시점 delivery_workflow.workflow_status (경로 B 승격 복원 기준, §5.4)';

-- 검증
-- SELECT ra.id, ra.entry_path, ra.entry_workflow_status
--   FROM refund_attempt ra
--   JOIN delivery_workflow w ON w.order_delivery_id = ra.order_delivery_id
--  WHERE w.cutover_migrated_at IS NOT NULL
--    AND ra.entry_workflow_status IS NULL;
-- 기대: 이 마이그레이션 이후 생성된 행은 0행
