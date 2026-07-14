-- api_app 에 require_external_order_id 컬럼 추가
-- 배경: 외부 API 주문의 이중발급 영구 방어선은 UNIQUE(api_app_id, external_order_id) 이지만,
--       externalOrderId 가 optional 이라 강제되지 않으면(전송 누락 시) 크래시/타임아웃 재시도에서
--       신규 주문이 생성돼 이중발급이 발생할 수 있다.
--       requireExternalCustomerId 와 대칭으로, 앱 단위로 externalOrderId 를 필수화하는 플래그.
-- 기본값 false: 기존 앱 무영향. 이중발급 방어가 필요한(reconcile 하는) 앱만 true 로 설정.

ALTER TABLE api_app
  ADD COLUMN require_external_order_id TINYINT(1) NOT NULL DEFAULT 0
    AFTER require_external_customer_id;
