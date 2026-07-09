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
 */
export const deriveOrderCodeFromId = (orderId: number): string =>
  `${OrderPrefixCode}${NumberToDigitsString(orderId, OrderDigitNumber)}`;
