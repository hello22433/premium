-- PIN 발급 중복 방지 테이블
-- 배경: 같은 orderDelivery에 대해 배치/수동 발송이 동시에 issue()를 호출하면
--       협력사 API가 두 번 호출되어 중복 PIN이 발급되는 사고가 발생할 수 있음.
--       특히 DAOU/GIFTIEL 등 멱등성 보호가 약한 협력사에서 위험.
-- 해결: PartnerCompanyExternService.issue() 진입 시 transactionId를 unique key로
--       INSERT하여 동시 호출을 DB unique 제약으로 차단.
-- 제외: CULTURELAND은 0099 응답 시 동일 transactionId 재요청으로 기발급 PIN을
--       복구하는 프로토콜을 사용하므로 dedup 대상에서 제외.

CREATE TABLE pin_issue_dedup (
  transaction_id    VARCHAR(64)  NOT NULL COMMENT '발급 거래번호 (orderDelivery.transactionId)',
  order_delivery_id INT          NOT NULL COMMENT 'FK) order_delivery.id',
  partner_type      VARCHAR(32)  NOT NULL COMMENT '협력사 타입',
  bar_code          VARCHAR(64)  NULL     COMMENT '발급된 PIN (성공 시 기록, 감사용)',
  issued_at         DATETIME(6)  NOT NULL COMMENT 'issue() 진입 시각',
  PRIMARY KEY (transaction_id),
  KEY idx_order_delivery_id (order_delivery_id)
) COMMENT='PIN 발급 중복 방지 dedup 테이블';
