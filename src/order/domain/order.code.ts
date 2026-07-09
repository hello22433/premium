import { randomUUID } from 'crypto';
import { NumberToDigitsString } from '../../util/digits';

export const OrderPrefixCode = 'EPEVT';
export const OrderDigitNumber = 11;

/**
 * 2-step 채번용 임시 주문코드.
 * order.code 는 NOT NULL·UNIQUE 라 id 확정 전 INSERT 시점에 임시값이 필요하다.
 * 'TMP-' 접두어라 확정코드(EPEVT%)와 절대 겹치지 않고, UUID 라 동시 INSERT 끼리도 겹치지 않는다.
 * 같은 트랜잭션에서 즉시 deriveOrderCodeFromId 로 교체되어 커밋 전 소멸한다(외부 노출 없음).
 */
export const createTempOrderCode = (): string => `TMP-${randomUUID()}`;

/**
 * 확정 주문코드 = EPEVT + order.id(11자리 zero-pad).
 * id 가 DB auto_increment(원자적·유일·재사용 없음)라 code 도 유일함이 보장된다.
 * "최신 code 읽고 +1"(CreateCode) 방식의 동시 채번 충돌(D3-51)을 원천 제거한다.
 *
 * "EPEVT + 정확히 11자리" 불변식을 downstream(LIKE/포맷)이 의존하므로,
 * id 가 양의 정수가 아니거나 11자리를 초과하면 조용히 깨뜨리지 않고 즉시 throw 한다.
 * (id 11자리 초과 = 999억 건, 근시일 도달 불가하나 방어적으로 명시)
 */
export const deriveOrderCodeFromId = (orderId: number): string => {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new Error(`deriveOrderCodeFromId: orderId 는 양의 정수여야 합니다 (받은 값: ${orderId})`);
  }
  if (String(orderId).length > OrderDigitNumber) {
    throw new Error(`deriveOrderCodeFromId: orderId 가 ${OrderDigitNumber}자리를 초과했습니다 (${orderId})`);
  }
  return `${OrderPrefixCode}${NumberToDigitsString(orderId, OrderDigitNumber)}`;
};
