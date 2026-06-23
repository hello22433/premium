-- 과거 정기파기 처리분 order_history PII 백필 (일회성)
--
-- 배경:
--   정기파기 배치(deliveryDeliveryTargetDestroy)는 과거에 order_delivery 의 수신처/계좌만 '-' 로
--   파기하고 order_history 는 건드리지 않았다. 이번 변경으로 배치가 order_history 의 PII 보유 이력
--   ('수신정보 변경요청'/'폐기 후 신규 발송' 의 before_change/after_change = 평문 수신처)도 함께
--   파기하지만, 배치의 재수집 필터가 order_delivery 의 PII 상태만 보므로 "이미 order_delivery 가
--   '-' 인 과거 건"은 재수집되지 않아 order_history PII 가 그대로 남는다.
--   → 그 과거 건의 order_history PII 를 본 스크립트로 일회성 마스킹한다. (신규 건은 배치가 자동 처리)
--
-- 대상/제외:
--   - 대상: PII 보유 type('수신정보 변경요청','폐기 후 신규 발송') 이면서, 소속 발송건의 delivery_target
--     이 이미 '-'(파기됨)이고, before_change/after_change 가 아직 마스킹되지 않은 행.
--   - 제외: 상태 감사 이력('폐기'/'환불폐기'/'핀상태 변경' 등) — before/after 가 couponStatus 전이
--     기록이므로 절대 마스킹하지 않는다(보존).
--   - content 는 본 백필 범위 밖(운영 정책 확인 후 별도).
--
-- 실행 전 대상 수 확인:
--   SELECT COUNT(*) FROM order_history h JOIN order_delivery d ON d.id = h.order_delivery_id
--    WHERE h.type IN ('수신정보 변경요청','폐기 후 신규 발송') AND d.delivery_target = '-'
--      AND (h.before_change <> '-' OR h.after_change <> '-');

UPDATE order_history h
JOIN order_delivery d ON d.id = h.order_delivery_id
SET h.before_change = '-', h.after_change = '-'
WHERE h.type IN ('수신정보 변경요청', '폐기 후 신규 발송')
  AND d.delivery_target = '-'
  AND (h.before_change <> '-' OR h.after_change <> '-');
