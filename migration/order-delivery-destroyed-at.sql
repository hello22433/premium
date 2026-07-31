-- order_delivery.destroyed_at 신설 + 레거시 백필 (멱등)
--
-- 무엇을 해결하나
--   개인정보 파기일을 "언제 지웠나"의 **기록**으로 답하기 위한 컬럼이다. 이 컬럼이 없던 동안
--   화면·파기확인서는 `발송요청일 + 파기일수` 로 파기일을 **역산**했는데, 이 방식은 파기 규칙이
--   바뀌는 순간 깨진다. 실제로 쿠폰 유효기간 가드가 들어오면서 규칙이
--     발송요청일 + N  →  MAX(발송요청일 + N, 유효기간 만료일 + 1일)
--   로 바뀌었고, 옛 규칙으로 이미 파기된 행에 새 규칙을 소급하자 **이미 지운 건에 수년 뒤 미래
--   날짜**가 인쇄됐다(재리뷰 H-1). 파기확인서는 대외 증빙이라 허위 증명이 된다.
--   → 추론을 버리고 파기 시점에 기록한다. 규칙이 또 바뀌어도 과거 기록은 흔들리지 않는다.
--
-- 실행 순서 (중요)
--   ① 이 스크립트의 §1(컬럼 추가)  → ② §2~§4(백필)  → ③ 코드 배포  → ④ §2~§4 재실행
--   ④가 필요한 이유: ②와 ③ 사이에 자정 정기파기 배치가 돌면 그 회차 행은 destroyed_at 이
--   비어 있다(코드가 아직 각인을 안 하므로). 백필은 전 구간 멱등이므로 그냥 다시 돌리면 된다.
--   ③을 ②보다 먼저 하면 파기된 행이 잠시 파기일 null 로 표시된다(거짓은 아니지만 공백).
--
-- 요구: MySQL 8.0+ (information_schema 기반 재실행 가드, LEAST). 실행 전 SELECT VERSION(); 확인.
-- 대상 테이블이 크면 §3/§4 는 배치 분할 실행을 권장한다(맨 아래 참고).

-- ── 1. 컬럼 추가 (재실행 안전) ────────────────────────────────────────────────
-- nullable + 테이블 끝 추가라 MySQL 8.0 에서는 ALGORITHM=INSTANT 로 즉시 끝난다(락 없음).
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_delivery' AND COLUMN_NAME = 'destroyed_at'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `order_delivery` ADD COLUMN `destroyed_at` datetime NULL COMMENT ''개인정보 파기 실행 시각''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. 백필 (1순위) — 조기파기 실적 ────────────────────────────────────────────
-- early_destroy_request.executed_at 은 **실측**이다. 계산으로는 이 시점에 도달할 수 없으므로
-- (조기파기는 예정일보다 앞당겨 지운다) 반드시 §3 보다 먼저 채운다.
--
-- item.order_delivery_id 는 nullable 이고, NULL 이면 "그 매핑의 발송건 **전체**"를 뜻한다.
-- 그래서 두 갈래로 나눠 채운다.
--
-- ⚠️ 같은 발송건이 여러 COMPLETED 요청에 걸릴 수 있다(executeRequest 에 '이미 파기됨' 거부가
--    없고, 매핑 지정 요청은 미파기 발송건이 하나라도 있으면 통과한다). 그때는 **가장 이른**
--    실행 시각을 쓴다 — 최초 파기가 그 PII 가 사라진 시점이기 때문이다. MIN() 이 그 규칙이다.

-- 2-1. 발송건이 명시된 항목
UPDATE `order_delivery` od
JOIN (
  SELECT i.order_delivery_id AS delivery_id, MIN(r.executed_at) AS destroyed_at
  FROM `early_destroy_request_item` i
  JOIN `early_destroy_request` r ON r.id = i.early_destroy_request_id
  WHERE r.status = 'COMPLETED'
    AND r.executed_at IS NOT NULL
    AND i.order_delivery_id IS NOT NULL
  GROUP BY i.order_delivery_id
) x ON x.delivery_id = od.id
SET od.destroyed_at = x.destroyed_at
WHERE od.destroyed_at IS NULL
  AND od.delivery_target = '-';   -- 실제로 지워진 행에만 각인(기록과 행 상태 불일치 방어)

-- 2-2. 매핑 전체 파기 항목 (order_delivery_id IS NULL)
-- ★ 시간축 필수 — "매핑 전체"는 **실행 시점의** 집합이지 지금의 집합이 아니다. 조기파기 이후
--   같은 매핑에 새 발송건이 생길 수 있으므로(CS 폐기후재발행이 동일 order_product_mapping_id 로
--   INSERT), created_at <= executed_at 인 행만 대상으로 한다. 이 조건이 없으면 파기 이후에
--   생긴 살아있는 PII 행에 "과거에 파기 완료" 도장이 찍혀 허위 증명이 된다.
-- ⚠️ 정밀도 비대칭: executed_at 은 datetime(초), created_at 은 datetime(6) 이다. 같은 초에
--   먼저 생성된 행이 '나중'으로 판정되지 않도록 created_at 을 초 단위로 내려 비교한다.
UPDATE `order_delivery` od
JOIN (
  SELECT i.order_product_mapping_id AS mapping_id, MIN(r.executed_at) AS destroyed_at
  FROM `early_destroy_request_item` i
  JOIN `early_destroy_request` r ON r.id = i.early_destroy_request_id
  WHERE r.status = 'COMPLETED'
    AND r.executed_at IS NOT NULL
    AND i.order_delivery_id IS NULL
  GROUP BY i.order_product_mapping_id
) x ON x.mapping_id = od.order_product_mapping_id
SET od.destroyed_at = x.destroyed_at
WHERE od.destroyed_at IS NULL
  AND od.delivery_target = '-'
  AND od.created_at IS NOT NULL
  AND DATE_SUB(od.created_at, INTERVAL MICROSECOND(od.created_at) MICROSECOND) <= x.destroyed_at;

-- ── 3. 백필 (2순위) — 정기파기 추정 ───────────────────────────────────────────
-- 정기파기 배치는 파기 시각을 남기지 않았으므로 실측이 없다. 옛 배치의 규칙
--   `DATE(발송요청일) + 파기일수`
-- 으로 채운다. **이것은 추정이다.** 다만 새로 만들어내는 오차가 아니라, 지금 화면이 이미
-- 보여주고 있는 바로 그 값이다(프론트가 같은 식으로 계산해 왔다). 오차 원인은 아래와 같고,
-- 전부 실제 파기를 **뒤로** 미루는 방향이라 이 값은 하한이다:
--   · 정기파기 배치 도입 전에 쌓여 있던 물량 → 배치 첫 회차에 한꺼번에 파기됨
--   · 주문이 DELIVERY_COMPLETE 에 늦게 도달
--   · 그날 환불이 PROGRESS/APPROVE → 그 회차 건너뜀
--   · 배치 회차 유실/장애
--
-- ⚠️ LEAST(..., NOW()) 클램프가 필수다. 파기일수 사후 편집(updateDestroyPersonalInfoDay 에는
--    상태 검사가 없어 이미 파기된 매핑의 일수도 바뀐다) 때문에 재계산값이 **미래**가 될 수 있고,
--    그러면 지금 고치려는 H-1(이미 지운 건에 미래 날짜)을 컬럼에 그대로 박제하게 된다.
--
-- 시각은 00:00:00 으로 남는다 — 정기파기 크론이 자정(0 0 * * *)에 돌기 때문이고, 실제로도
-- 그 시각이 맞다. 화면은 날짜만 쓰므로 표시에는 영향이 없다.
UPDATE `order_delivery` od
JOIN `order_product_mapping` opm ON opm.id = od.order_product_mapping_id
SET od.destroyed_at = LEAST(
      DATE_ADD(DATE(opm.send_request_at), INTERVAL opm.request_to_destroy_personal_info_day DAY),
      NOW()
    )
WHERE od.destroyed_at IS NULL
  AND od.delivery_target = '-'
  AND opm.send_request_at IS NOT NULL
  AND opm.request_to_destroy_personal_info_day IS NOT NULL;

-- ── 4. 검증 ──────────────────────────────────────────────────────────────────
-- 4-1. 남은 미확정 행 = 파기됐는데 시각을 모르는 행. 기준 컬럼(send_request_at /
--      request_to_destroy_personal_info_day)이 결측이라 계산조차 못 한 건이다.
--      이 행들은 API 가 파기일 null 로 응답한다(날짜를 지어내지 않는다). 0 이 이상적이지만
--      0 이 아니어도 정상 동작이며, 건수만 파악해 두면 된다.
SELECT COUNT(*) AS `파기됐으나_시각미상`
FROM `order_delivery` od
WHERE od.delivery_target = '-' AND od.destroyed_at IS NULL;

-- 4-2. 미파기 행에 시각이 찍혀 있으면 안 된다(있으면 백필 조건 오류 — 살아있는 PII 에
--      "파기 완료" 도장). 반드시 0 이어야 한다.
SELECT COUNT(*) AS `미파기인데_시각있음_반드시0`
FROM `order_delivery` od
WHERE od.delivery_target <> '-' AND od.destroyed_at IS NOT NULL;

-- 4-3. 미래 날짜가 남아 있으면 안 된다(§3 의 LEAST 클램프 검증). 반드시 0 이어야 한다.
SELECT COUNT(*) AS `파기시각이_미래_반드시0`
FROM `order_delivery` od
WHERE od.destroyed_at > NOW();

-- 4-4. 실측(조기파기)과 추정(정기파기)의 비율. 감사 시 "이 값이 사실인가 추정인가"를 판단하는
--      근거가 된다. 별도 출처 컬럼을 두지 않았으므로 이 쿼리 결과를 실행 기록으로 남길 것.
SELECT
  SUM(CASE WHEN TIME(od.destroyed_at) <> '00:00:00' THEN 1 ELSE 0 END) AS `실측추정_조기파기`,
  SUM(CASE WHEN TIME(od.destroyed_at)  = '00:00:00' THEN 1 ELSE 0 END) AS `추정추정_정기파기`
FROM `order_delivery` od
WHERE od.destroyed_at IS NOT NULL;

-- ── 참고: 대용량 분할 실행 ────────────────────────────────────────────────────
-- order_delivery 가 수백만 행이면 §3 을 한 번에 돌리지 말고 id 구간으로 쪼갠다.
-- 전 구간이 `destroyed_at IS NULL` 조건이라 중단·재실행이 안전하다.
--   UPDATE ... WHERE od.destroyed_at IS NULL AND od.delivery_target = '-'
--     AND od.id BETWEEN @from AND @to ...
