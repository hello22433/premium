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

-- ── 0. 드라이런 & 되돌리기 ────────────────────────────────────────────────────
-- 이 스크립트는 **§1(DDL) 을 빼면 전부 되돌릴 수 있다.** 그 사실이 어디에도 적혀 있지 않아
-- 실제보다 위험해 보인다는 지적을 받아 여기 명시한다.
--
-- (가) 드라이런 — UPDATE 전에 "몇 건이 바뀌는가"를 먼저 센다.
--      · §2 대상 건수: §3 의 실행 전 가드 쿼리(아래 §3 첫 SELECT)를 **§2 를 돌리기 전에**
--        실행하면 그 값이 곧 §2 가 각인할 건수다. §2 후 같은 쿼리가 0 이 되는지로 검증한다.
--        (같은 쿼리가 실행 시점에 따라 '대상 수'와 '잔량 검증'이 된다 — 조건이 동일하므로.)
--      · §3 대상 건수:
--          SELECT COUNT(*) AS `S3_대상건수`
--          FROM `order_delivery` od
--          JOIN `order_product_mapping` opm ON opm.id = od.order_product_mapping_id
--          WHERE od.destroyed_at IS NULL AND od.delivery_target = '-'
--            AND opm.send_request_at IS NOT NULL
--            AND opm.request_to_destroy_personal_info_day IS NOT NULL;
--      · 그중 미래로 튀어 NOW() 로 눌리는(= 근거가 가장 약한) 건수까지 미리 보려면 위 쿼리에
--          AND DATE_ADD(DATE(opm.send_request_at),
--                       INTERVAL opm.request_to_destroy_personal_info_day DAY) > NOW()
--        를 덧붙인다. 이 수치가 곧 H-1(이미 지운 건에 미래 날짜) 모집단의 크기다.
--
-- (나) 되돌리기 — 백필이 각인한 값만 정확히 지운다:
--        UPDATE `order_delivery`
--        SET destroyed_at = NULL, destroyed_at_source = NULL
--        WHERE destroyed_at_source IN ('BACKFILL_EARLY', 'BACKFILL_ESTIMATE');
--      런타임 각인(EARLY/BATCH)과 섞이지 않고 골라낼 수 있는 것은 **출처 컬럼 덕분**이다
--      (출처 컬럼의 부수 효과 — 없었다면 날짜만으로는 분리가 불가능했다).
--      코드 배포(③) 전이면 이걸로 완전한 원상복구다. 배포 후에 돌려도 런타임이 남긴 실측은
--      보존되므로 안전하다. 되돌린 뒤 §2 → §3 → §4 를 순서대로 다시 돌리면 된다.
--      ⚠️ 컬럼 자체를 되돌리는 것(§1 취소 = DROP COLUMN)은 코드 배포 후에는 order_delivery
--         조회 경로가 전면 실패하므로 **코드를 먼저 롤백**해야 한다.
--
-- (다) 트랜잭션 — §2 · §3 은 각각 단일 UPDATE 라 그 자체로 원자적이다. 둘을 하나로 묶고
--      싶으면 START TRANSACTION; (§2) (§3) COMMIT; 로 감쌀 수 있으나, 대형 테이블에서는
--      언두 로그가 커지고 락 보유 시간이 길어지므로 권장하지 않는다. 중간에 끊겨도 전 구간이
--      `destroyed_at IS NULL` 조건이라 재실행이 안전하다(멱등). 단 **순서(§2 → §3)만은
--      지켜야 한다** — §3 이 선점하면 §2 는 영원히 못 고친다(§3 가드 참조).

-- ── 1. 컬럼 추가 (재실행 안전) ────────────────────────────────────────────────
-- nullable + 테이블 끝 추가라 MySQL 8.0 은 INSTANT 로 처리할 수 있다.
-- ALGORITHM/LOCK 을 **명시**한다 — 생략하면 옵티마이저가 COPY 로 떨어져도 조용히 진행되어
-- 대형 테이블에서 락이 걸린다. 명시하면 INSTANT 불가 시 에러로 즉시 알려 주므로(fail-loud)
-- 운영이 판단할 기회가 생긴다. MySQL 8.0 미만/MariaDB 등에서 에러가 나면 그때 옵션을 빼고
-- 점검 시간대에 수동 실행할 것.
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_delivery' AND COLUMN_NAME = 'destroyed_at'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `order_delivery` ADD COLUMN `destroyed_at` datetime NULL COMMENT ''개인정보 파기 실행 시각'', ALGORITHM=INSTANT',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- destroyed_at 의 **출처**. 그 값이 사실인지 추정인지를 판별하는 유일한 근거다.
-- 날짜만으로는 구분할 수 없다 — 시각 기반 추론(자정이면 추정)은 양방향으로 틀린다:
--   · §3 의 LEAST 가 NOW() 를 고른 **추정** 행은 자정이 아니다
--   · 자정 크론(0 0 * * *)이 찍는 **진짜 실측**은 자정이다
-- 이 값이 파기확인서(대외 증빙)에 나가므로 "이 날짜가 실제 기록입니까"에 답할 수 있어야 한다.
-- 값: EARLY / BATCH / BACKFILL_EARLY(§2) / BACKFILL_ESTIMATE(§3)  — 추정은 마지막 하나뿐.
-- 어휘 단일 소스는 src/order/domain/destroyed.at.source.ts 다. 한쪽을 바꾸면 다른 쪽도 바꿀 것.
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_delivery' AND COLUMN_NAME = 'destroyed_at_source'
);
SET @sql := IF(@src_exists = 0,
  'ALTER TABLE `order_delivery` ADD COLUMN `destroyed_at_source` varchar(32) NULL COMMENT ''파기 시각의 출처 (사실/추정 판별)'', ALGORITHM=INSTANT',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. 백필 (1순위) — 조기파기 실적 ────────────────────────────────────────────
-- early_destroy_request.executed_at 은 **실측**이다. 계산으로는 이 시점에 도달할 수 없으므로
-- (조기파기는 예정일보다 앞당겨 지운다) 반드시 §3 보다 먼저 채운다.
--
-- item.order_delivery_id 는 nullable 이고, NULL 이면 "그 매핑의 발송건 **전체**"를 뜻한다.
-- 두 갈래를 UNION ALL 로 **하나의 후보 목록**으로 합친 뒤 발송건 단위로 MIN 을 취한다.
--
-- ★★ 왜 하나로 합쳤나 — 이게 이 스크립트에서 가장 틀리기 쉬운 지점이다.
--
--   (가) **집계와 필터의 순서.** 시간축 필터는 반드시 MIN **이전에** 걸려야 한다.
--        매핑 단위로 먼저 MIN 을 뽑고 나중에 시간축을 걸면, "그 발송건을 실제로 지운 요청"이
--        MIN 이 아닐 때 그 행이 통째로 탈락한다.
--        예: 매핑 M 에 요청 R1(02-01), R2(04-01). 발송건 D2 는 03-01 생성(폐기후재발행) →
--            R2 가 지웠다. 그런데 매핑 MIN = 02-01 이라 `03-01 <= 02-01` 이 거짓 → D2 탈락 →
--            §3 이 추정값(예: 06-29)을 박제. **실측 04-01 이 DB 에 있는데도** 2개월 뒤 날짜가
--            증빙에 인쇄된다. §4 검증 4종 어느 것도 이걸 못 잡는다.
--        아래처럼 후보 단계에서 `created_at <= r.executed_at` 를 걸면 R1 만 탈락하고 R2 가
--        살아남아 D2 = 04-01 이 된다.
--
--   (나) **두 갈래의 상호 선점.** §2-1 을 먼저 UPDATE 하고 §2-2 를 나중에 돌리면, §2-2 는
--        `destroyed_at IS NULL` 때문에 스킵된다. 매핑 전체 요청이 더 이른 시각이어도 반영되지
--        않아 MIN 규칙이 깨진다. 하나의 UPDATE 로 합치면 이 순서 의존이 사라진다.
--
--   MIN 을 쓰는 이유: 같은 발송건이 여러 COMPLETED 요청에 걸릴 수 있는데(매핑 지정 요청은
--   미파기 발송건이 하나라도 있으면 통과한다), **최초 파기가 그 PII 가 사라진 시점**이기 때문이다.
--
--   ⚠️ 다만 런타임과 **완전히 같지는 않다**(이전 주석의 "런타임도 같은 규칙" 은 정정한다).
--      런타임 각인 분기는 둘이다:
--        · 이미 파기된 행을 다시 파기        → 최초 시각 **유지** (early.destroy.service.ts)
--          = MIN 과 일치
--        · 파기 후 CS 수신정보 변경으로 되살아난 행을 재파기 → **새 시각으로 갱신**
--          (delivery.batch.service.ts 의 '부활 재파기' 각인 분기)   = MIN 과 **불일치**
--      백필은 두 번째를 표현하지 못한다. 부활 이력이 파기 때 함께 마스킹돼 데이터만으로는
--      "이 행이 되살아났다가 다시 지워진 것인지"를 판별할 수 없기 때문이다.
--      결과적으로 **부활 재파기된 레거시 행은 최초 파기 시각이 BACKFILL_EARLY(=실측) 로
--      각인된다 — 값은 최신 파기가 아닌데 딱지는 '사실'이다.** 빈도는 낮지만(조기파기 +
--      CS 수신처 변경 + 재파기가 모두 겹쳐야 한다) 방향이 나쁘므로 여기 남긴다.
--      후보에서 빼는 방안(출처 미상으로 남김)은 판별이 불가능해 멀쩡한 실측까지 버리게 되므로
--      채택하지 않았다. 개별 건 확인이 필요하면 order_history 의 수신정보 변경 이력을 볼 것.
--
-- ★ 시간축이 필요한 이유 — "매핑 전체"는 **실행 시점의** 집합이지 지금의 집합이 아니다.
--   조기파기 이후 같은 매핑에 새 발송건이 생길 수 있으므로(CS 폐기후재발행이 동일
--   order_product_mapping_id 로 INSERT), 파기 이후에 생긴 행에 "과거에 파기 완료" 도장이 찍히면
--   허위 증명이 된다.
-- ⚠️ 정밀도 비대칭: executed_at 은 datetime(초), created_at 은 datetime(6) 이다. 같은 초에
--   먼저 생성된 행이 '나중'으로 판정되지 않도록 created_at 을 초 단위로 내려 비교한다.
--   (절삭은 포함을 **넓히는** 방향이다. 살아있는 PII 에 도장이 찍히는 것은 아래
--    `delivery_target = '-'` 게이트가 막으므로, 남는 편차는 ±1초뿐이다.)
UPDATE `order_delivery` od
JOIN (
  SELECT c.delivery_id, MIN(c.executed_at) AS destroyed_at
  FROM (
    -- (a) 발송건이 명시된 항목: 그 1건만 대상. 시간축 불필요(대상이 이미 특정돼 있다).
    SELECT i.order_delivery_id AS delivery_id, r.executed_at
    FROM `early_destroy_request_item` i
    JOIN `early_destroy_request` r ON r.id = i.early_destroy_request_id
    WHERE r.status = 'COMPLETED'
      AND r.executed_at IS NOT NULL
      AND i.order_delivery_id IS NOT NULL

    UNION ALL

    -- (b) 매핑 전체 항목: 그 매핑의 발송건으로 펼치되, **요청 하나하나에** 시간축을 건다.
    SELECT od2.id AS delivery_id, r.executed_at
    FROM `early_destroy_request_item` i
    JOIN `early_destroy_request` r ON r.id = i.early_destroy_request_id
    JOIN `order_delivery` od2 ON od2.order_product_mapping_id = i.order_product_mapping_id
    WHERE r.status = 'COMPLETED'
      AND r.executed_at IS NOT NULL
      AND i.order_delivery_id IS NULL
      AND od2.created_at IS NOT NULL
      AND DATE_SUB(od2.created_at, INTERVAL MICROSECOND(od2.created_at) MICROSECOND) <= r.executed_at
  ) c
  GROUP BY c.delivery_id
) x ON x.delivery_id = od.id
SET od.destroyed_at = x.destroyed_at,
    od.destroyed_at_source = 'BACKFILL_EARLY'   -- 실측(요청서 executed_at 복사)
WHERE od.destroyed_at IS NULL
  AND od.delivery_target = '-';   -- 실제로 지워진 행에만 각인(기록과 행 상태 불일치 방어)

-- ── 3. 백필 (2순위) — 정기파기 추정 ───────────────────────────────────────────
-- ★ 실행 전 가드: §2 가 끝났는지 확인한다. **반드시 0 이어야 한다.**
--   §3 을 §2 보다 먼저 돌리면 조기파기 실측이 있는 행을 추정값이 선점하고, §2 는
--   `destroyed_at IS NULL` 조건이라 **영원히 못 고친다**. 아래 "대용량 분할 실행" 안내가
--   §3 만 따로 돌리도록 유도할 수 있어 특히 위험하다.
--
-- ⚠️ 후보 정의는 §2 와 **완전히 동일해야** 한다. 매핑 단위로 조인하면 조기파기와 무관한 형제
--    발송건까지 잡혀서, §2 가 정상 완료돼도 0 이 아니게 된다(= 운영자가 정상 상황에서 §3 을
--    중단한다). 아래는 §2 의 UNION ALL 후보를 그대로 재사용해 **발송건 단위**로 맞춘 것이다.
SELECT COUNT(*) AS `S3_실행전_반드시0__조기파기_미각인_잔량`
FROM `order_delivery` od
JOIN (
  SELECT i.order_delivery_id AS delivery_id
  FROM `early_destroy_request_item` i
  JOIN `early_destroy_request` r ON r.id = i.early_destroy_request_id
  WHERE r.status = 'COMPLETED' AND r.executed_at IS NOT NULL AND i.order_delivery_id IS NOT NULL
  UNION ALL
  SELECT od2.id AS delivery_id
  FROM `early_destroy_request_item` i
  JOIN `early_destroy_request` r ON r.id = i.early_destroy_request_id
  JOIN `order_delivery` od2 ON od2.order_product_mapping_id = i.order_product_mapping_id
  WHERE r.status = 'COMPLETED' AND r.executed_at IS NOT NULL AND i.order_delivery_id IS NULL
    AND od2.created_at IS NOT NULL
    AND DATE_SUB(od2.created_at, INTERVAL MICROSECOND(od2.created_at) MICROSECOND) <= r.executed_at
) c ON c.delivery_id = od.id
WHERE od.delivery_target = '-' AND od.destroyed_at IS NULL;

-- 정기파기 배치는 파기 시각을 남기지 않았으므로 실측이 없다. 옛 배치의 규칙
--   `DATE(발송요청일) + 파기일수`
-- 으로 채운다. **이것은 추정이다.** 다만 새로 만들어내는 오차가 아니라, 지금 화면이 이미
-- 보여주고 있는 바로 그 값이다(프론트가 같은 식으로 계산해 왔다).
--
-- ⚠️ 오차는 **양방향**이다. 처음에는 "전부 파기를 뒤로 미루는 방향이라 하한"이라고 적었으나
--    그것은 틀렸다. 아래 (나) 때문에 과거로도 미끄러진다.
--   (가) 실제보다 **이른** 값이 나오는 원인 — 실제 파기가 계산일보다 늦어진 경우:
--        · 정기파기 배치 도입 전에 쌓여 있던 물량 → 배치 첫 회차에 한꺼번에 파기됨
--        · 주문이 DELIVERY_COMPLETE 에 늦게 도달
--        · 그날 환불이 PROGRESS/APPROVE → 그 회차 건너뜀
--        · 배치 회차 유실/장애
--   (나) **파기일수 사후 편집** — updateDestroyPersonalInfoDay 에 상태 검사가 없어 이미 파기된
--        매핑의 일수도 바뀐다. 180 → 60 으로 **하향** 편집됐다면 재계산값이 실제 파기일보다
--        훨씬 이르다(예: 실제 06-30 인데 03-02 로 각인). LEAST 는 미래만 막을 뿐 이 방향은
--        못 막는다. §4-5 가 의심 행을 집계하므로 반드시 확인할 것.
--
-- ⚠️ LEAST(..., NOW()) 클램프는 그 반대 방향(미래)을 막는다. 일수를 **상향** 편집하면
--    재계산값이 미래가 되고, 그러면 지금 고치려는 H-1(이미 지운 건에 미래 날짜)을 컬럼에
--    그대로 박제하게 된다.
--
-- 시각은 대개 00:00:00 으로 남는다(정기파기 크론이 자정에 돌므로 실제로도 그 시각이 맞다).
-- 단 LEAST 가 NOW() 를 고른 행은 자정이 아니다 — 이 시각을 실측/추정 판별에 쓰지 말 것(§4-4).
UPDATE `order_delivery` od
JOIN `order_product_mapping` opm ON opm.id = od.order_product_mapping_id
SET od.destroyed_at = LEAST(
      DATE_ADD(DATE(opm.send_request_at), INTERVAL opm.request_to_destroy_personal_info_day DAY),
      NOW()
    ),
    od.destroyed_at_source = 'BACKFILL_ESTIMATE'   -- ★ 추정. 이 값만 사실이 아니다.
WHERE od.destroyed_at IS NULL
  AND od.delivery_target = '-'
  AND opm.send_request_at IS NOT NULL
  AND opm.request_to_destroy_personal_info_day IS NOT NULL;

-- ── 4. 검증 ──────────────────────────────────────────────────────────────────
-- 4-1. 남은 미확정 행 = 파기됐는데 시각을 모르는 행. 이 행들은 API 가 파기일 null 로 응답한다.
--      ⚠️ 단순 카운트로는 "영구히 계산 불가"와 "§3 이 안 끝남"을 구분할 수 없다. 후자는 재실행이
--      필요하고 전자는 아니므로, 사유별로 나눠서 본다. **마지막 컬럼이 0 이 아니면 §3 을 다시
--      돌려야 한다.**
-- (COALESCE 필수 — 대상이 0행이면 SUM 은 0 이 아니라 NULL 을 돌려준다. NULL 을 "0건"으로
--  읽어 넘기기 쉬우므로 명시적으로 0 으로 내린다.)
SELECT
  COALESCE(SUM(CASE WHEN opm.id IS NULL THEN 1 ELSE 0 END), 0)                       AS `매핑고아_계산불가`,
  COALESCE(SUM(CASE WHEN opm.id IS NOT NULL AND opm.send_request_at IS NULL
           THEN 1 ELSE 0 END), 0)                                                    AS `발송요청일결측_계산불가`,
  COALESCE(SUM(CASE WHEN opm.id IS NOT NULL AND opm.send_request_at IS NOT NULL
            AND opm.request_to_destroy_personal_info_day IS NULL
           THEN 1 ELSE 0 END), 0)                                                    AS `파기일수결측_계산불가`,
  COALESCE(SUM(CASE WHEN opm.send_request_at IS NOT NULL
            AND opm.request_to_destroy_personal_info_day IS NOT NULL
           THEN 1 ELSE 0 END), 0)                                                    AS `설명불가_S3미완_재실행필요`
FROM `order_delivery` od
LEFT JOIN `order_product_mapping` opm ON opm.id = od.order_product_mapping_id
WHERE od.delivery_target = '-' AND od.destroyed_at IS NULL;

-- 4-2. 미파기 행에 시각이 찍혀 있는 건. **백필 직후에만 0 이어야 한다.**
--      ⚠️ "항상 반드시 0"이 아니다 — 운영 중에는 **정상적으로 발생하는 상태**가 있다:
--         파기된 뒤 CS 수신정보 변경으로 수신처가 되살아나고 아직 다음 배치 회차가 오지 않은 행.
--         배치는 그 행을 '부활 재파기'로 분류해 새 시각으로 갱신하도록 설계돼 있다
--         (delivery.batch.service.ts 의 각인 분기). 즉 이 조합 자체는 결함이 아니다.
--      백필 직후(코드 배포 전)에는 부활 경로가 아직 개입하지 않았으므로 0 이어야 하고,
--      0 이 아니면 백필 조건 오류다(살아있는 PII 에 "파기 완료" 도장).
--      운영 중 조회해서 0 이 아니면 → 해당 행이 부활 대기 상태인지 먼저 확인할 것.
SELECT COUNT(*) AS `미파기인데_시각있음__백필직후0_운영중엔_부활대기_확인`
FROM `order_delivery` od
WHERE od.delivery_target <> '-' AND od.destroyed_at IS NOT NULL;

-- 4-3. 미래 날짜가 남아 있으면 안 된다(§3 의 LEAST 클램프 검증). 반드시 0 이어야 한다.
SELECT COUNT(*) AS `파기시각이_미래_반드시0`
FROM `order_delivery` od
WHERE od.destroyed_at > NOW();

-- 4-4. 출처별 분포. **감사 대비로 이 결과를 실행 기록에 반드시 남길 것.**
--      "이 파기일이 사실인가 추정인가"에 답하는 유일한 근거다. 시각으로 판별하려던 초기 시도는
--      양방향으로 틀렸다(§1 의 destroyed_at_source 주석 참조) — 그래서 출처를 값에 적는다.
--      BACKFILL_ESTIMATE 만 추정이고 나머지는 실측이다. 이 수치가 곧 "추정으로 증빙되는 건수"다.
SELECT
  COALESCE(od.destroyed_at_source, '(출처미상)') AS `출처`,
  COUNT(*)                                        AS `건수`,
  CASE WHEN od.destroyed_at_source = 'BACKFILL_ESTIMATE' OR od.destroyed_at_source IS NULL
       THEN '추정' ELSE '실측' END                AS `성격`
FROM `order_delivery` od
WHERE od.destroyed_at IS NOT NULL
GROUP BY od.destroyed_at_source
ORDER BY `건수` DESC;

-- 4-6. 출처 누락 검증 — 파기 시각은 있는데 출처가 없는 행. 반드시 0 이어야 한다.
--      0 이 아니면 각인 경로 중 하나가 출처를 안 쓰고 있다는 뜻이고, 그 행들은 사실/추정을
--      영원히 판별할 수 없다.
SELECT COUNT(*) AS `시각있는데_출처없음_반드시0`
FROM `order_delivery`
WHERE destroyed_at IS NOT NULL AND destroyed_at_source IS NULL;

-- 4-5. §3 (나) 검증 — 파기일수 사후 편집으로 추정값이 실제와 어긋날 가능성이 있는 행.
--      ⚠️ **과대 보고된다.** updated_at 은 파기일수뿐 아니라 그 매핑의 **어떤 컬럼이 바뀌어도**
--         갱신되므로, 여기 걸린 행이 전부 일수 편집인 것은 아니다. "확정"이 아니라 "이 행들은
--         파기일 신뢰도를 개별 확인하라"는 **선별 목록**으로 쓸 것.
--      0 이 이상적이지만 0 이 아니어도 즉시 문제는 아니다. 대외 증빙(파기확인서)에 쓰기 전에
--      해당 주문의 파기일수 변경 이력을 확인하면 된다.
SELECT COUNT(*) AS `파기일수_사후편집_의심`
FROM `order_delivery` od
JOIN `order_product_mapping` opm ON opm.id = od.order_product_mapping_id
WHERE od.destroyed_at IS NOT NULL
  AND opm.updated_at > od.destroyed_at
  AND od.destroyed_at_source = 'BACKFILL_ESTIMATE';   -- 추정 각인 행으로 한정(시각 프록시는 틀린다)

-- ── 참고: 대용량 분할 실행 ────────────────────────────────────────────────────
-- order_delivery 가 수백만 행이면 §3 을 한 번에 돌리지 말고 id 구간으로 쪼갠다.
-- 전 구간이 `destroyed_at IS NULL` 조건이라 중단·재실행이 안전하다.
--   UPDATE ... WHERE od.destroyed_at IS NULL AND od.delivery_target = '-'
--     AND od.id BETWEEN @from AND @to ...
