# 후속: /order/delivery-cancel 소유권 검사 (보안)

> 상태: **별도 티켓 권장(보안)**. 197-16 이 만든 문제는 아니나, 이 티켓이 이 엔드포인트에 자금 반환을 얹었다.
> 근거: 197-16 리뷰(code-reviewer / architect lane).

## 문제

`POST /order/delivery-cancel` 은 **메서드 레벨 소유권 가드가 없다**. 클래스 가드
`AuthUserAuthorizationGuard` 는 JWT 유효성만 검증하고, 서비스의 `order.userId = :userId` 조건도 주석 처리돼 있다.

→ 인증된 아무 사용자나 **주문 id 만 알면 타 테넌트의 예약 발송을 취소**시킬 수 있다.
   환불은 그 주문 명의로 가므로 금전 탈취는 아니고 **서비스 방해(발송 취소)** 다.

## 이미 막혀 있는 것 (오해 방지)

- `deliveryIds` 로 **타 주문의 발송건**을 취소하는 것은 불가능하다. CAS 의
  `EXISTS(... AND opm.order_id = :orderId)` 가 정확히 막는다(197-16 로컬 QA T5 로 실증: 타 주문 발송건 혼입 → 400,
  내 주문·타 주문 모두 미취소·미환불).
- 즉 노출은 "남의 **주문 전체/그 주문의 발송건**을 취소" 로 한정되며, 크로스 주문 발송건 혼입은 아니다.

## 착수 시

- 컨트롤러/서비스에 주문 소유권 검사 복원(billingUserId 또는 order.userId 대조). 대행주문(clientUserId)·
  운영자 권한(SUPER/OPERATION) 예외를 기존 조회 API 의 권한 패턴과 맞출 것.
- 자금·비가역 경로이므로 회귀 테스트(타 테넌트 주문 취소 시도 → 403) 동반.
