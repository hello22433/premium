/**
 * 쿠폰상태 변형(폐기/외부취소/재발행) lease 의 stale 임계 (ms).
 *
 * 변형 작업은 외부 통신(협력사 cancel/issue, 문자 발송)을 포함해 수 초가 걸린다.
 * 크래시로 finally 해제를 못 탄 lease 는 이 시간이 지나면 다음 획득자가 CAS 로 강탈한다(self-heal).
 * 좀비(정지했다 깨어난 소유자)의 뒤늦은 쓰기는 owner-guard(WHERE mutation_claimed_at=:my) 가 차단한다.
 *
 * reSend/resendFailedDelivery 의 RESEND_CLAIM_STALE_MS 와 동일 의미(5분).
 */
export const MUTATION_CLAIM_STALE_MS = 5 * 60 * 1000;
