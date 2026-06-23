-- order_delivery_refund.ssg_balance_settled 컬럼 추가
-- plans/ssg-balance-refactor.md PR3 보강
--
-- 배경: SSG 행사 잔액 보정(SsgRefundResolverService) 이 throw 흡수되면
-- 후속 재발송 가드가 "복구 안 됨"을 알 수 없어 이중 차감 위험 발생.
-- ledger row 에 SSG 잔액 보정 완료 여부를 별도 신호로 보관해 재발송 가드에서 차단한다.
--
-- 의미:
--  - true  : SSG 잔액 보정 완료 (resolver RESTORED 또는 SKIPPED_CONFIRMED). 재발송 가드 통과 가능.
--  - false : SSG 잔액 보정 미완료/실패 (resolver DEFERRED 또는 호출 실패). 재발송 가드 차단 + 운영 점검.
--
-- 기존 row 마이그레이션:
--  비-SSG 주문 → true (의미 없음, 가드에서도 SSG type 분기로 영향 X)
--  SSG 주문 → true (정상 흐름 가정. 이전 버그 영향 row 는 별도 데이터 보정 안 함 — 정책)

ALTER TABLE order_delivery_refund
  ADD COLUMN ssg_balance_settled BOOLEAN NOT NULL DEFAULT TRUE
    COMMENT 'SSG 행사 잔액 보정 완료 여부. SSG resolver 성공 시 true. 재발송 가드에서 사용 (false = 보정 미완료 = 새 선차감 차단)';
