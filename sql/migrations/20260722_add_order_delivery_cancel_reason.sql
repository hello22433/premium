-- order_delivery 에 발송건 단위 취소 사유/시각 추가 (197-16 예약건 부분취소)
--
-- ┌─ 실행 순서 ────────────────────────────────────────────────────────────────┐
-- │ (0) 사전 확인  → 이미 적용됐는지 본다. 적용돼 있으면 (1)을 건너뛴다.        │
-- │ (1) 컬럼 추가 (canceled_at, cancel_reason 을 한 문장에서)                   │
-- │ 그 다음: 애플리케이션 배포                                                 │
-- └────────────────────────────────────────────────────────────────────────────┘
-- ※ 이 파일과 20260722_add_ssg_event_amount_history_delivery.sql 사이에는 순서 의존이 없다
--   (다른 테이블). 다만 둘 다 앱 배포보다 먼저 적용돼야 한다 — 엔티티가 두 컬럼을 선언하므로
--   컬럼 없이 앱이 뜨면 order_delivery 를 읽는 조회가 Unknown column 으로 전부 실패한다.
--   취소 API 하나가 아니라 주문/발송 조회 전체가 영향을 받는다.
--
-- 배경: 취소 사유는 order.cancel_reason / order.canceled_at 에만 있어 주문 단위다.
--       부분취소는 한 주문에서 여러 번 발생할 수 있어(상품행별 예약시각이 다름),
--       주문 단위 컬럼만 쓰면 마지막 취소 사유가 앞선 사유를 덮어쓴다.
-- 해결: 발송건마다 사유/시각을 남긴다. 주문 단위 컬럼은 전체취소용으로 그대로 유지한다.
-- 백필: 하지 않는다. 기존 취소 건은 주문 전체 취소이므로 order.cancel_reason 이 이미 정확하다.


-- (0) 사전 확인 — 0건이면 미적용, 2건이면 이미 적용된 상태다.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'order_delivery'
   AND COLUMN_NAME IN ('canceled_at', 'cancel_reason')
 ORDER BY ORDINAL_POSITION;


-- (1) 컬럼 추가
--     두 컬럼을 한 문장에 두는 것은 의도적이다 — 인덱스가 섞이지 않은 ADD COLUMN 만의 조합은
--     INSTANT 로 처리될 수 있어(MySQL 8.0.29+ 는 AFTER 지정도 INSTANT 지원) 나눌 이유가 없다.
--     인덱스를 추가할 일이 생기면 그때는 반드시 별도 문장으로 분리할 것
--     (섞으면 INSTANT 가 선택되지 않아 테이블이 리빌드된다).
--     ※ ALGORITHM=INSTANT 를 명시하지는 않았다. 서버 버전/엔진이 조건을 못 채우면 조용히
--       리빌드로 폴백하므로, 대상 테이블이 큰 환경에서는 적용 전 실행계획/소요시간을 확인할 것.
ALTER TABLE `order_delivery`
  ADD COLUMN `canceled_at` DATETIME(6) NULL
    COMMENT '발송건 취소 시각. 취소 판정은 status=CANCEL 로 할 것 (이 컬럼은 부가 정보)'
    AFTER `discarded_at`,
  -- order.cancel_reason 은 text 지만 여기는 varchar(1000) 로 둔다.
  -- 요청 DTO 가 @MaxLength(1000) 으로 이미 제한하고 있어 저장 한도를 스키마에 명시한다.
  ADD COLUMN `cancel_reason` VARCHAR(1000) NULL
    COMMENT '발송건 취소 사유'
    AFTER `canceled_at`;


-- (2) 검증-A: 컬럼 정의와 위치.
--     기대 — 4건이 discarded_at → canceled_at → cancel_reason → refunded_at 순으로 나온다.
--     canceled_at 은 datetime(6), cancel_reason 은 varchar(1000), 둘 다 IS_NULLABLE=YES.
--     NOT NULL 로 만들어졌다면 잘못이다. 기존 행이 전부 NULL 이라 즉시 실패한다.
SELECT ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'order_delivery'
   AND COLUMN_NAME IN ('discarded_at', 'canceled_at', 'cancel_reason', 'refunded_at')
 ORDER BY ORDINAL_POSITION;


-- (3) 검증-B: 기존 행 무손상.
--     기대 — canceled / reasoned 둘 다 0. 백필하지 않으므로 전 행이 NULL 이어야 한다.
--     기존 취소 건의 사유는 order.cancel_reason 에 그대로 남아 있고 이 컬럼으로 옮기지 않는다.
SELECT COUNT(*) AS total_rows,
       COALESCE(SUM(`canceled_at` IS NOT NULL), 0) AS canceled,
       COALESCE(SUM(`cancel_reason` IS NOT NULL), 0) AS reasoned
  FROM `order_delivery`;


-- (4) 롤백 — 코드(엔티티) 롤백을 먼저 끝낸 뒤에만 실행할 것.
--     엔티티가 컬럼을 선언한 채로 컬럼을 지우면 조회가 전부 깨진다.
-- ALTER TABLE `order_delivery`
--   DROP COLUMN `cancel_reason`,
--   DROP COLUMN `canceled_at`;
