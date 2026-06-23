-- Giftiel push 교환 이벤트 이력 테이블
-- 배경: Giftiel이 교환(L1)/교환취소(L2) 이벤트를 webhook으로 push 전송
--       레거시 Java가 받던 것을 NestJS로 이관하며 신설
-- 용도:
--   1) 월별 정산 (auth_date 범위 조회로 L1/L2 이벤트 집계)
--   2) Pull 배치/수동갱신 시 tradeAt/tradePlace 덮어쓰기 방지 (최신 L1 존재 여부 확인)
--   3) 매칭 실패 수동 조치 (order_delivery_id NULL 건 경고 후 보관)
-- 중복 방지: (tr_id, cmd_type, auth_date) UNIQUE - Giftiel 재시도 수신 시 멱등 보장

CREATE TABLE giftiel_exchange_history (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_delivery_id  INT          NULL     COMMENT 'FK) order_delivery.id (매칭 실패 시 NULL)',
  matched_by         ENUM('TR_ID','COUPON_NUMBER','NONE') NOT NULL COMMENT '매칭 방식',
  tr_id              VARCHAR(100) NOT NULL COMMENT '트랜잭션 ID',
  coupon_number      VARCHAR(50)  NOT NULL COMMENT '쿠폰번호',
  cmd_type           ENUM('L1','L2') NOT NULL COMMENT '처리타입 (L1: 교환, L2: 교환취소)',
  serv_code          VARCHAR(4)   NOT NULL COMMENT '판매사 코드',
  auth_code          VARCHAR(20)  NULL     COMMENT '승인번호',
  auth_date          DATETIME     NOT NULL COMMENT '교환일시 / 교환취소일시',
  use_price          DECIMAL(20,2) NULL    COMMENT '사용금액 / 취소금액',
  bal_price          DECIMAL(20,2) NULL    COMMENT '잔액',
  coupon_type        VARCHAR(2)   NULL     COMMENT '쿠폰 종류 (00: 교환/할인권, 02: 금액권)',
  bi_code            VARCHAR(20)  NULL     COMMENT '사용가맹점 코드',
  bi_name            VARCHAR(50)  NULL     COMMENT '사용가맹점 명',
  date_time          VARCHAR(19)  NULL     COMMENT 'Giftiel 전달일시',
  result_code        VARCHAR(4)   NULL     COMMENT 'Giftiel 응답코드',
  result_msg         VARCHAR(500) NULL     COMMENT 'Giftiel 응답메시지',
  request_ip         VARCHAR(45)  NOT NULL COMMENT '요청 IP',
  received_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '수신 시각',
  created_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  deleted_at         DATETIME(6)  NULL,

  UNIQUE KEY uk_giftiel_exchange_tr_auth (tr_id, cmd_type, auth_date),
  KEY idx_giftiel_exchange_order_delivery  (order_delivery_id),
  KEY idx_giftiel_exchange_od_cmd_auth     (order_delivery_id, cmd_type, auth_date),
  KEY idx_giftiel_exchange_coupon_number   (coupon_number),
  KEY idx_giftiel_exchange_auth_date       (auth_date)
) COMMENT='Giftiel push 교환 이벤트 이력';
