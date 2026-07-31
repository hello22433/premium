/**
 * order_delivery.destroyed_at 의 출처.
 *
 * 파기일이 **사실인지 추정인지**를 판별하는 유일한 근거다. 날짜 값만으로는 구분할 수 없고
 * (시각 기반 추론은 양방향으로 틀린다 — order.delivery.entity.ts 의 destroyedAtSource 주석 참조),
 * 이 값이 파기확인서라는 대외 증빙에 나가므로 출처를 데이터에 남긴다.
 *
 * 이 상수는 런타임 각인 경로가 쓴다. 백필 값(BACKFILL_*)은 migration/order-delivery-destroyed-at.sql
 * 이 직접 문자열로 넣으므로 여기서 참조되지 않지만, **같은 어휘를 쓰는 곳이 둘**이라는 사실을
 * 드러내기 위해 전부 나열한다. 한쪽을 바꾸면 다른 쪽도 바꿔야 한다.
 */
export const DESTROYED_AT_SOURCE = {
  /** 조기파기 실행 시 각인 (early.destroy.service). 사실. */
  EARLY: 'EARLY',
  /** 정기파기 배치 실행 시 각인 (delivery.batch.service). 사실. */
  BATCH: 'BATCH',
  /** 컬럼 신설 백필 — 조기파기 요청서의 executed_at 을 복사한 값. 사실. */
  BACKFILL_EARLY: 'BACKFILL_EARLY',
  /** 컬럼 신설 백필 — `발송요청일 + 파기일수` 로 역산한 값. **추정**. */
  BACKFILL_ESTIMATE: 'BACKFILL_ESTIMATE',
} as const;

export type DestroyedAtSource = (typeof DESTROYED_AT_SOURCE)[keyof typeof DESTROYED_AT_SOURCE];

/**
 * 이 값이 추정인가. 사실/추정 축에서는 BACKFILL_ESTIMATE 하나만 추정이다.
 *
 * NULL 은 "출처를 모른다"이므로 사실이라고 단정할 수 없다 — 추정으로 취급한다(fail-closed).
 * 대외 증빙에서 "모른다"를 "사실"로 승격시키면 그게 곧 허위 진술이 되기 때문이다.
 */
export const isEstimatedDestroyedAt = (source: string | null | undefined): boolean =>
  source !== DESTROYED_AT_SOURCE.EARLY &&
  source !== DESTROYED_AT_SOURCE.BATCH &&
  source !== DESTROYED_AT_SOURCE.BACKFILL_EARLY;

/**
 * "이 발송건은 **지금** 파기돼 있는가."
 *
 * ⚠️ deliveryTarget 하나만 보면 안 된다. CS 수신정보 변경은 **이메일+핀발급 건에서
 *    emailReceiverPhone 만** 갱신하고 deliveryTarget 은 건드리지 않는다
 *    (customer.service.service.ts 의 RECEIVER_CHANGE 분기). 파기 후 emailReceiverPhone 은
 *    '-' 라 truthy 이므로 그 분기에 그대로 들어가고, 결과는
 *      delivery_target = '-'  +  email_receiver_phone = <살아있는 암호화 전화번호>
 *    가 된다. deliveryTarget 만 보면 이 행이 "파기됨"으로 판정되어
 *      · 파기일이 과거 실적으로 인쇄되고(살아있는 PII 옆에 "파기 완료 2026-03-01")
 *      · 배치가 부활로 분류하지 않아 그 기간이 감사기록에서 사라진다
 *    판정 순서를 뒤집어 막으려던 모순이 **다른 컬럼으로 그대로 재현**된다(리뷰 HIGH-1).
 *
 * emailReceiverPhone 이 NULL 인 것은 "그 경로를 쓰지 않는 발송건"이라는 뜻이므로 파기로 본다.
 *
 * ⚠️ 파기확인서 발행 게이트와의 관계 — **"게이트는 1축이라 안전하다"고 읽지 말 것.**
 *
 *    게이트(destruction.certificate.gate.ts)는 이 술어를 **직접 호출하지는 않는다.** 전량
 *    파기 판정은 여전히 deliveryTarget 단일이다. 그러나 그 직후 파기일 축
 *    (resolveOrderEffectiveDestroyAt)을 교차검증하고, 그 함수가 이 술어를 쓴다. 결과적으로
 *    **게이트는 2축을 포함하고, 거기에 날짜 축이 하나 더 붙는다 — 즉 2축보다 엄격하다.**
 *    (2축으로는 파기된 행이라도 destroyed_at 이 없으면 DESTROY_TIME_UNKNOWN 으로 막힌다.
 *     '동등'이 아니다. 차단 사유가 어느 것이 되는지는 게이트의 우선순위 주석을 볼 것.)
 *
 *    (이 문단은 원래 정반대를 서술하고 있었다 — "게이트를 넓히면 레거시 행에서 발행이 새로
 *     막혀 운영 회귀가 되므로 의도적으로 1축을 유지한다". 그 서술은 게이트에 교차검증이
 *     들어오면서 거짓이 됐다. 그대로 두면 다음 사람이 "게이트는 1축이니 레거시 회귀는 없다"고
 *     결론 내려 아래 회귀의 존재 자체를 놓치므로 정정한다 — 리뷰 4차 H-3.)
 *
 *    그래서 경고했던 그 회귀는 **실제로 발생할 수 있다**(현재 운영 실측 0건): delivery_target='-'
 *    + emailReceiverPhone 생존 행은 kind 가 SCHEDULED 가 되어 게이트가 막는다 — 대개
 *    NOT_DESTROYED 지만, 발송요청일·파기일수가 결측이거나 형제 발송건이 파기일 null 을 내면
 *    DESTROY_TIME_UNKNOWN 이 된다. 유효기간이 남아 있으면 그 기간 내내 막힌다.
 *    이것은 **수용된 회귀**다 — 그 행에는 실제로 살아있는 PII 가 있으므로 "전량 파기됨"을
 *    증명할 수 없는 것이 맞다.
 *    규모는 migration/order-delivery-destroyed-at.sql 의 §4-8 로 계량한다.
 *    ⚠️ 2026-07-31 운영 실측 0/0 은 "**지금 미마스킹 잔량이 없다**"는 뜻이지 "레거시 부분마스킹이
 *       존재한 적 없다"는 뜻이 아니다 — 만료된 레거시 행은 배치가 이미 마스킹을 끝내 그 쿼리에
 *       잡히지 않는다. 앞으로 값이 오르면 CS 수신정보 변경일 가능성이 높다는 정도로 읽을 것.
 *
 *    반면 백필(§2·§3)은 여전히 `delivery_target = '-'` **1축**이다. 표시·발행·백필 셋의 축이
 *    완전히 같지는 않다는 점을 알고 쓸 것.
 */
export const isDeliveryDestroyed = (delivery: {
  deliveryTarget: string;
  emailReceiverPhone?: string | null;
}): boolean =>
  delivery.deliveryTarget === '-' &&
  (delivery.emailReceiverPhone === null ||
    delivery.emailReceiverPhone === undefined ||
    delivery.emailReceiverPhone === '-');
