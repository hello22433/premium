import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';

/**
 * 실효 개인정보 파기예정일 계산.
 *
 * 화면·발송완료 보고서가 "발송요청일 + N일"만 표시하던 것을, 정기파기 배치가 실제로 파기하는
 * 날짜와 일치시키기 위한 단일 소스다. 유효기간이 파기예정일보다 뒤인 상품(예: 유효기간 5년 /
 * 파기 180일)에서 배치가 만료까지 파기를 보류하므로, 고지 날짜도 그만큼 뒤로 가야 한다.
 *
 * ⚠️ 이 함수는 delivery.batch.service.ts 의 deliveryDeliveryTargetDestroy 쿼리와 **같은 규칙을
 *    손으로 복제한 것**이다. SQL 은 "파기 대상인가"(불리언)를 묻고 여기서는 "언제 파기되는가"
 *    (날짜)를 묻기 때문에 코드 공유가 불가능하다. 한쪽을 고치면 반드시 다른 쪽도 고칠 것.
 *    두 규칙이 어긋나면 고객사에 고지한 파기일과 실제 파기일이 달라진다.
 *
 *    배치 쿼리는 5개 절의 AND 이고, 그중 이 함수가 날짜로 옮긴 것은 2개뿐이다. 나머지 3개가
 *    어떻게 되는지까지 알아야 대조가 성립하므로 전부 적는다:
 *      1) DATE_ADD(DATE(sendRequestAt), INTERVAL requestToDestroyPersonalInfoDay DAY) <= DATE(now)
 *         → 반영. baseDestroyAt.
 *      2) order.status = DELIVERY_COMPLETE
 *         → 호출부가 보장한다(발송완료 보고서는 이 상태에서만 조회된다).
 *      3) refundStatus IS NULL OR NOT IN (PROGRESS, APPROVE)
 *         → 미반영. 그날 환불 진행중이면 배치가 건너뛰고 종결 후 회차에서 파기한다(더 늦어진다).
 *      4) PII 5종 중 하나라도 미파기
 *         → **부분 반영.** 조기파기로 이미 지워진 건은 earlyDestroyedAt 실적일로 답한다
 *            (deliveryTarget === '-' 를 함께 확인한다 — 아래 resolveDeliveryDestroyAt 참조).
 *            정기파기로 지워진 건은 실적 기록이 없어 계산값으로 답한다.
 *      5) (expireAt IS NULL OR DATE(expireAt) < DATE(now) OR deletedAt IS NOT NULL)
 *         → 반영. 유효기간 가드.
 *
 *    ⇒ 따라서 반환값의 성격은 건마다 다르다:
 *      · 조기파기된 건 → **실적일**(확정)
 *      · 그 외        → **배치가 파기할 수 있는 가장 이른 날짜**(추정). 3) 때문에 뒤로 밀릴 수
 *        있고, 배치 회차가 유실되거나 주문이 DELIVERY_COMPLETE 를 이탈하면(외부 API 취소 등)
 *        더 늦어지거나 아예 파기되지 않는다. 즉 이 축은 여전히 하한이지 실적이 아니다.
 *
 *    판정 기준은 쿠폰 상태가 아니라 유효기간 하나다 — 사용(USED)·폐기·환불폐기 여부와 무관하게
 *    유효기간이 남아 있으면 파기하지 않는다(운영 결정).
 *
 * ⚠️ 입력 집합 주의: 이 함수는 **hideDiscardReissueDeliveries 를 적용하기 전** 집합을 받아야 한다.
 *    그 함수는 폐기후재발행 tip(replacedFromId != null)을 목록에서 지우는데 배치에는 그 필터가
 *    없어 tip 도 파기 대상이다. 필터 후 집합을 넘기면 tip 의 늦은 유효기간이 MAX 에서 빠져
 *    실제보다 이른 날짜를 고지하게 된다.
 *
 * 반환값은 시분초를 0 으로 절삭한 로컬(KST) 날짜다. 배치가 DATE() 단위로 비교하고 자정에 도는
 * 것과 맞춘다. 서버 TZ 가 KST 라는 전제에 의존한다(main.ts 최상단의 process.env.TZ='Asia/Seoul').
 * 그 전제가 깨지면 KST 00:00~08:59 에 걸친 expireAt 에서 하루 어긋난다 — DB 커넥션은 별도로
 * timezone:'+09:00' 이라 SQL 쪽 DATE() 는 KST 를 유지하기 때문이다.
 * 계산 불가(발송건 없음/기준 컬럼 결측)면 null 을 돌려주고, 호출부는 종전 표시로 폴백한다 —
 * 근거 없는 날짜를 지어내지 않는다.
 */

/**
 * 파기 완료 마커. 정기파기(delivery.batch.service)·조기파기(early.destroy.service)가 PII 를
 * 마스킹할 때 쓰는 값이며, 파기확인서 게이트(destruction.certificate.gate.ts)의 판정 술어와도
 * 같아야 한다 — 세 곳이 어긋나면 "파기됐다"의 정의가 화면마다 달라진다.
 */
const DESTROY_VALUE = '-';

/** 시분초를 버린 로컬 날짜. */
const atStartOfDay = (value: Date): Date => {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
};

const addDays = (value: Date, days: number): Date => {
  const d = new Date(value);
  d.setDate(d.getDate() + days);
  return d;
};

/**
 * 발송건 1건의 파기일.
 *
 * **이미 파기된 건은 실적일을, 아직 파기되지 않은 건은 예정일을 돌려준다.**
 * 이 값은 파기확인서의 '파기일' 칸에도 쓰이므로(대외 증빙), 이미 지운 건에 미래 날짜를 주면
 * 거짓 증명이 된다. 그래서 실적을 알 수 있으면 실적이 항상 우선한다.
 *
 * 실적을 아는 경로는 조기파기뿐이다(early_destroy_request.executedAt). 정기파기 배치는 파기
 * 시각을 따로 기록하지 않으므로, 그 축은 계산값으로 답할 수밖에 없다. 배치가 정상적으로 돌면
 * 계산값과 실적이 일치하지만 **보장은 아니다** — 환불 진행중이면 그 회차를 건너뛰고, 회차가
 * 유실되면 다음 날로 밀리며, 주문이 DELIVERY_COMPLETE 를 이탈하면(외부 API 취소 등) 아예
 * 파기되지 않는데도 이 함수는 계속 날짜를 답한다. 즉 정기파기 축은 '대체로 맞는 추정'이다.
 * 반대로 조기파기는 계산식보다 앞당겨 지우므로 추정으로는 접근조차 안 되고, 그래서 실적
 * (executedAt)을 받아야 한다.
 * ⚠️ "정기파기는 계산값이 곧 실적"이라는 전제가 깨지는 경로가 둘 있다.
 *    ① 조기파기 요청을 거치지 않는 수동 파기 경로가 새로 생기는 경우 — 이 함수는 그 건을 다시
 *       예정일로 답한다. 그런 경로를 추가할 때는 실적 기록도 함께 남겨야 한다.
 *    ② **파기일수 사후 편집** — EarlyDestroyService.updateDestroyPersonalInfoDay 는 상태 검사가
 *       없어 이미 파기된 매핑의 requestToDestroyPersonalInfoDay 도 바꿀 수 있다. ②는 그 값을
 *       **현재값으로 재계산**하므로, 파기 후 일수를 줄이면 실제보다 이른 날짜가, 늘리면 이미
 *       지운 건에 미래 날짜가 인쇄된다. 편집 시점에 파기 여부를 막는 가드가 없는 한 이 경로는
 *       열려 있다(운영 영향이 있어 이 브랜치에서 가드를 넣지는 않았다).
 *
 * 예정일 계산 = DATE(발송요청일) + N일. 여기에 유효기간 가드가 적용되는 건(= 유효기간이 아직
 * 남은 건)만 만료 다음 날까지 미뤄진다. 가드 비적용 2종(유효기간 없음 / soft-delete)은 기준일
 * 그대로다. 쿠폰 상태(USED·CANCEL 등)는 판정에 쓰지 않는다 — 유효기간이 남아 있으면 사용
 * 완료된 쿠폰도 보류한다.
 *
 * 배치는 두 조건을 AND 로 묶으므로 실제 파기 최초 시점은 두 날짜의 MAX 다.
 *
 * deletedAt 분기는 발송완료 보고서 경로에서는 사실상 도달하지 않는다 — soft-delete 되는 것은
 * 되감긴 tip 뿐이고 tip 은 replacedFromId 가 있어 호출부가 먼저 걸러내는 경우가 많다. 배치와의
 * 규칙 대조를 위해 남긴 방어 분기다.
 * null 판정이 expireAt(=== null && === undefined)과 deletedAt(=== null)에서 비대칭인 점에 주의.
 * 부분 select/DTO 투영으로 deletedAt 이 undefined 로 들어오면 가드가 조용히 꺼져 실제보다 이른
 * 날짜가 나온다. 엔티티를 그대로 넘기면(현 호출부) @DeleteDateColumn 이 항상 선택되어 안전하다.
 */
export function resolveDeliveryDestroyAt(
  delivery: Pick<OrderDeliveryEntity, 'expireAt' | 'deletedAt' | 'deliveryTarget'>,
  sendRequestAt: Date | null | undefined,
  destroyDay: number | null | undefined,
  earlyDestroyedAt?: Date | null,
): Date | null {
  // 실적 우선. 조기파기로 이미 지운 건은 예정일이 아니라 지운 날을 답해야 한다.
  // 이 분기가 없으면 유효기간 5년 상품을 발송 한 달 만에 조기파기했을 때 파기확인서에
  // 4년 11개월 뒤 날짜가 인쇄된다(리뷰 HIGH-1).
  //
  // ★ 단, 실적을 인정하려면 **그 행 자신이 실제로 지워져 있어야** 한다(deliveryTarget === '-').
  //   조기파기 실적은 early_destroy_request 라는 '별도 기록'에서 역추론한 값이라, 기록과 행의
  //   현재 상태가 어긋날 수 있다. 대표 경로는 '매핑 전체 파기 후 재발행'이다 —
  //   CS 폐기후재발행이 같은 orderProductMappingId 로 새 행을 만들기 때문에
  //   (customer.service.service.ts:2298), 파기 시점 이후에 생긴 그 행까지 "그때 파기됨"으로
  //   도장이 찍힌다. 그 행은 실제 수신처를 보유하고 있으므로, 살아있는 PII 를 두고
  //   "과거에 파기 완료"라고 인쇄하는 허위 증명이 된다.
  //   행 자신의 상태를 함께 보면 이 역추론의 틈이 닫힌다 — 파기확인서 게이트가 쓰는 술어와
  //   같은 것을 쓰므로(destruction.certificate.gate.ts) 두 화면이 어긋나지도 않는다.
  if (earlyDestroyedAt && delivery.deliveryTarget === DESTROY_VALUE) return atStartOfDay(earlyDestroyedAt);

  // 배치 주 절이 INTERVAL NULL DAY → NULL 이 되어 이 행을 영원히 집지 않는다. 파기일을 특정할
  // 수 없으므로 null. (실제로 파기되지 않는 상태이므로 날짜를 지어내면 거짓 고지가 된다.)
  if (!sendRequestAt || destroyDay === null || destroyDay === undefined) return null;

  const baseDestroyAt = addDays(atStartOfDay(sendRequestAt), destroyDay);

  const guardApplies = delivery.expireAt !== null && delivery.expireAt !== undefined && delivery.deletedAt === null;

  if (!guardApplies) return baseDestroyAt;

  // 만료 당일은 아직 유효하므로 다음 날 회차에서 파기된다 — 배치의 `DATE(expireAt) < DATE(now)`.
  const expiryDestroyAt = addDays(atStartOfDay(delivery.expireAt as Date), 1);

  return expiryDestroyAt > baseDestroyAt ? expiryDestroyAt : baseDestroyAt;
}

/**
 * 주문 전체가 파기 완료되는 날짜 = 소속 발송건 파기일의 MAX.
 *
 * 보고서·화면은 주문 단위로 날짜 하나를 보여주는데, 발송건마다 expireAt 이 다를 수 있다.
 * "이 날이면 전부 지워져 있다"를 보장해야 고지로서 의미가 있으므로 최댓값을 쓴다.
 *
 * 파기일을 특정할 수 없는 발송건(null)이 하나라도 있으면 주문 전체도 null 이다 — 일부만 보고
 * "전부 파기됨"이라 고지할 수 없다.
 *
 * 그 보장은 **넘겨받은 집합에 한정**된다. 호출부가 발송건을 걸러낸 뒤 넘기면 걸러진 건은 MAX 에
 * 들어가지 않는다. 위 ⚠️ 대로 hideDiscardReissueDeliveries 적용 전 집합을 넘겨야 하는 이유다.
 *
 * earlyDestroyedAtByDeliveryId: 조기파기로 이미 지운 발송건의 실적일(order_delivery.id → 실행시각).
 * 호출부가 early_destroy_request(COMPLETED)에서 만들어 넘긴다. 넘기지 않으면 전부 예정일로
 * 계산되므로, 파기확인서처럼 실적이 필요한 화면을 그리는 경로에서는 반드시 채워야 한다.
 * 일부만 조기파기된 주문에서는 실적일과 예정일이 섞여 MAX 를 이루는데, 그래도 "이 날이면 전부
 * 지워져 있다"는 의미는 유지된다 — 실적일은 이미 지난 날이고 예정일은 앞으로 올 날이라, 둘을
 * 섞어 최댓값을 잡아도 "그 시점엔 전부 정리됨"이 성립하기 때문이다.
 * (다만 "실적일은 MAX 에 영향을 주지 않는다"고 단정하지는 말 것 — 발송건이 **전부** 조기파기된
 *  주문에서는 MAX 가 곧 실적일이다. 발송건 1건짜리 주문이 그 대표 사례다.)
 */
export function resolveOrderEffectiveDestroyAt(
  order: Pick<OrderEntity, 'orderProductMappings'>,
  // ★ 선택 인자가 아니다. optional 로 두면 호출부에서 두 번째 인자를 빠뜨려도 컴파일이 통과하고
  //   결과는 "전부 예정일" — 이 기능이 막으려던 버그(이미 지운 건에 미래 날짜)로 조용히
  //   되돌아간다. 필수로 강제해 배선 회귀를 런타임 결함이 아니라 컴파일 에러로 만든다.
  //   실적이 필요 없는 경로는 new Map() 을 명시적으로 넘겨 "의도한 것"임을 남길 것.
  earlyDestroyedAtByDeliveryId: ReadonlyMap<number, Date>,
): Date | null {
  const mappings: OrderProductMappingEntity[] = order.orderProductMappings ?? [];

  let latest: Date | null = null;

  for (const mapping of mappings) {
    for (const delivery of mapping.orderDeliveries ?? []) {
      const destroyAt = resolveDeliveryDestroyAt(
        delivery,
        mapping.sendRequestAt,
        mapping.requestToDestroyPersonalInfoDay,
        earlyDestroyedAtByDeliveryId.get(delivery.id),
      );
      // 특정 불가한 건이 하나라도 있으면 주문 전체를 특정할 수 없다.
      if (destroyAt === null) return null;
      if (latest === null || destroyAt > latest) latest = destroyAt;
    }
  }

  // 발송건이 하나도 없으면 초기값 null 이 그대로 나간다 — "증명할 내용이 없다"와 같은 뜻이다.
  // (발송건이 있으면 위 루프에서 최소 1회 갱신되므로 여기서 latest 는 반드시 non-null 이다.)
  return latest;
}
