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
 * ⚠️ 파기확인서 발행 게이트(destruction.certificate.gate.ts)는 **의도적으로** 이 술어를 쓰지
 *    않고 deliveryTarget 단일 판정을 유지한다. 게이트를 넓히면 emailReceiverPhone 이 한 번도
 *    마스킹된 적 없는 레거시 행에서 발행이 새로 막혀 운영 회귀가 된다. 표시(이 술어)는 좁게,
 *    발행(게이트)은 종전대로 — 두 축이 다르다는 것을 알고 쓸 것.
 */
export const isDeliveryDestroyed = (delivery: {
  deliveryTarget: string;
  emailReceiverPhone?: string | null;
}): boolean =>
  delivery.deliveryTarget === '-' &&
  (delivery.emailReceiverPhone === null ||
    delivery.emailReceiverPhone === undefined ||
    delivery.emailReceiverPhone === '-');
