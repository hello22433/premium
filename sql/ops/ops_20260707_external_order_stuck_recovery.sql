-- =============================================================================
-- 외부/SSG 주문 완료전이 drift — 기존 backlog 복구 (일회성 ops)
--
-- 배경:
--   ExternalApiService.createOrder/createSsgOrder 는 A(주문/차감) → B(쿠폰발급+발송)
--   → C(order=DELIVERY_COMPLETE) 의 비원자 3-phase. B 성공 후 C 커밋 전 프로세스가 죽으면
--   쿠폰/문자는 이미 나갔는데 order 가 DELIVERY_REQUEST 로 stuck 된다.
--
--   코드 픽스(dispatchSend 가 delivery_send_history.order_delivery_id 를 채움) 이후 발생분은
--   ExternalOrderRecoveryService 스윕이 자동 복구한다. 그러나 픽스 이전(legacy) 성공 이력은
--   order_delivery_id 가 NULL 이라 스윕이 연결하지 못한다. 이 스크립트로 legacy 이력을
--   해당 delivery 에 back-link 하면, 이후 스윕이 5분 내 자동으로 완료 전이한다.
--
-- 안전 원칙:
--   - target(=encryptDeliveryTarget, 결정적) + delivery_method 일치 + 주문 등록시각 이후 30분 이내
--     로 후보를 좁힌다.
--   - 반드시 STEP 1 진단으로 match_count=1 (양방향 유일) 인 건만 확인한 뒤,
--     STEP 2 에서 그 delivery_send_history.id 를 명시해 back-link 한다. 대량 자동 UPDATE 금지.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1) 진단: stuck 외부/SSG 주문 + 매칭되는 발송 성공(미연결) 이력 후보
--   match_count 가 1 이 아니면(0=이력없음, 2+=중복 후보) 자동 back-link 금지 → 수동 판단.
-- -----------------------------------------------------------------------------
SELECT
  o.id                        AS order_id,
  o.code                      AS order_code,
  o.type                      AS order_type,
  o.status                    AS order_status,
  o.register_at,
  od.id                       AS delivery_id,
  od.status                   AS delivery_status,
  od.delivery_method,
  od.bar_code,
  dsh.id                      AS send_history_id,
  dsh.is_success,
  dsh.created_at              AS sent_at,
  (
    SELECT COUNT(*)
    FROM delivery_send_history d2
    WHERE d2.order_delivery_id IS NULL
      AND d2.is_success = 1
      AND d2.target = od.delivery_target
      AND d2.delivery_method = od.delivery_method
      AND d2.created_at >= o.register_at
      AND d2.created_at < o.register_at + INTERVAL 30 MINUTE
  )                           AS match_count
FROM `order` o
JOIN order_product_mapping opm ON opm.order_id = o.id
JOIN order_delivery od         ON od.order_product_mapping_id = opm.id
LEFT JOIN delivery_send_history dsh
       ON dsh.order_delivery_id IS NULL
      AND dsh.is_success = 1
      AND dsh.target = od.delivery_target
      AND dsh.delivery_method = od.delivery_method
      AND dsh.created_at >= o.register_at
      AND dsh.created_at < o.register_at + INTERVAL 30 MINUTE
WHERE o.type IN ('EXTERNAL', 'SSG')
  AND o.status = 'DELIVERY_REQUEST'
  AND od.status = 'WAIT'
  AND od.bar_code IS NOT NULL
ORDER BY o.id DESC;

-- -----------------------------------------------------------------------------
-- STEP 2) back-link: STEP 1 에서 match_count=1 로 확인된 send_history_id 만 명시.
--   (예시: send_history_id = 12345 를 delivery_id = 6789 에 연결)
--   여러 건이면 (send_history_id, delivery_id) 쌍을 나열해 각각 실행.
-- -----------------------------------------------------------------------------
-- UPDATE delivery_send_history
--   SET order_delivery_id = /*<delivery_id>*/
--   WHERE id = /*<send_history_id>*/
--     AND order_delivery_id IS NULL
--     AND is_success = 1;

-- -----------------------------------------------------------------------------
-- STEP 3) (선택) 즉시 완료 전이 — back-link 후 스윕(5분 주기)을 기다리지 않으려면 수동 실행.
--   스윕과 동일한 CAS: delivery WAIT→COMPLETE(+actualSendAt), order DELIVERY_REQUEST→DELIVERY_COMPLETE.
--   back-link(STEP 2) 를 먼저 반드시 수행할 것.
-- -----------------------------------------------------------------------------
-- UPDATE order_delivery od
-- JOIN delivery_send_history dsh
--      ON dsh.order_delivery_id = od.id AND dsh.is_success = 1
--   SET od.status = 'COMPLETE',
--       od.actual_send_at = COALESCE(od.actual_send_at, dsh.created_at)
--   WHERE od.id = /*<delivery_id>*/
--     AND od.status = 'WAIT';
--
-- UPDATE `order`
--   SET status = 'DELIVERY_COMPLETE'
--   WHERE id = /*<order_id>*/
--     AND status = 'DELIVERY_REQUEST';
