import { randomUUID } from 'crypto';

/** Gemtek `EXT_COL2` 는 varchar(32) 라 UUID 를 하이픈 없이 32자로 기입한다(§9 Gemtek DBA 계약). */
export const ATTEMPT_ID_LENGTH = 32;

const ATTEMPT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * 메시지 시도 상관키(`message_attempt.attempt_id` = `MSG_QUEUE.EXT_COL2`)를 생성한다.
 *
 * 주문번호처럼 추측 가능한 값이나 시각 기반 ID 를 쓰지 않고 **무작위**로 만들며,
 * 개인정보(수신번호·이름·email)를 포함하지 않는다(§3 다·§8.3).
 * 재발송은 원 행을 불변으로 두고 새 행을 만들므로 매 시도가 새 상관키를 갖는다(§5.3).
 */
export function generateAttemptId(): string {
  return randomUUID().replace(/-/g, '');
}

/** 상관키 형식(소문자 hex 32자) 검증. 외부에서 받은 값을 신뢰하지 않기 위한 가드. */
export function isValidAttemptId(value: string | null | undefined): boolean {
  return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value);
}
