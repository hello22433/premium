/**
 * order_history.beforeChange/afterChange 가 PII(전화번호·이메일·핀번호)를 담는 type 목록.
 *  - '수신정보 변경요청': beforeChange=옛 수신처, afterChange=새 수신처
 *  - '폐기 후 신규 발송': afterChange=`새 수신처 / 새 핀번호`
 * 그 외 type('폐기'/'환불폐기'/'핀상태 변경'/'재전송' 등)의 beforeChange/afterChange 는
 * couponStatus 전이 감사값(NOT_USED→CANCEL 등)이므로 절대 마스킹하면 안 된다.
 *
 * 정기파기(delivery.batch.service)·조기파기(early.destroy.service) 양쪽에서 공유하는 **단일 소스**.
 * (DI 없는 leaf 상수 — 모듈 순환참조 없이 양쪽 import 가능)
 *
 * ⚠️ order_history.type 은 enum 미강제 매직 스트링이다. writer(customer.service.service.ts 의
 * mapHistory/execHistory)가 쓰는 문자열 리터럴과 정확히 일치해야 한다.
 */
export const PII_BEARING_HISTORY_TYPES = ['수신정보 변경요청', '폐기 후 신규 발송'] as const;
