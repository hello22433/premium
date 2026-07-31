import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';

/**
 * 실효 개인정보 파기일 계산.
 *
 * 화면·발송완료 보고서가 "발송요청일 + N일"만 표시하던 것을, 정기파기 배치가 실제로 파기하는
 * 날짜와 일치시키기 위한 단일 소스다. 유효기간이 파기예정일보다 뒤인 상품(예: 유효기간 5년 /
 * 파기 180일)에서 배치가 만료까지 파기를 보류하므로, 고지 날짜도 그만큼 뒤로 가야 한다.
 *
 * ── 이 함수가 답하는 두 가지 질문 ──────────────────────────────────────────────
 * 겉보기엔 하나의 날짜를 돌려주지만, 행의 상태에 따라 **성격이 전혀 다른 값**이 나온다.
 *   · 이미 파기된 행 → "언제 지웠나"  = **실적**. order_delivery.destroyed_at 을 그대로 읽는다.
 *   · 아직 안 지운 행 → "언제 지울까"  = **예측**. 배치 규칙을 날짜로 옮겨 계산한다.
 *
 * 예측을 과거에 쓰면 안 된다는 것이 이 설계의 핵심이다. 예측식으로 과거를 답하려면 "그때 쓰던
 * 규칙 == 지금 쓰는 규칙"이어야 하는데, 규칙은 실제로 바뀐다. 유효기간 가드가 들어오면서
 * `발송요청일 + N` → `MAX(발송요청일 + N, 만료일 + 1)` 로 바뀌었고, 옛 규칙으로 이미 파기된
 * 행에 새 규칙을 소급하자 **이미 지운 건에 수년 뒤 날짜**가 나왔다(재리뷰 H-1).
 * 그래서 파기 시점에 destroyed_at 을 남기고, 과거는 계산하지 않고 **읽는다**.
 *
 * ⚠️ 예측 경로는 delivery.batch.service.ts 의 deliveryDeliveryTargetDestroy 쿼리와 **같은 규칙을
 *    손으로 복제한 것**이다. SQL 은 "파기 대상인가"(불리언)를 묻고 여기서는 "언제 파기되는가"
 *    (날짜)를 묻기 때문에 코드 공유가 불가능하다. 한쪽을 고치면 반드시 다른 쪽도 고칠 것.
 *
 *    배치 쿼리는 5개 절의 AND 이고, 그중 예측이 날짜로 옮긴 것은 2개뿐이다. 나머지 3개가
 *    어떻게 되는지까지 알아야 대조가 성립하므로 전부 적는다:
 *      1) DATE_ADD(DATE(sendRequestAt), INTERVAL requestToDestroyPersonalInfoDay DAY) <= DATE(now)
 *         → 반영. baseDestroyAt.
 *      2) order.status = DELIVERY_COMPLETE
 *         → 호출부가 보장한다(발송완료 보고서는 이 상태에서만 조회된다).
 *      3) refundStatus IS NULL OR NOT IN (PROGRESS, APPROVE)
 *         → 미반영. 그날 환불 진행중이면 배치가 건너뛰고 종결 후 회차에서 파기한다(더 늦어진다).
 *      4) PII 5종 중 하나라도 미파기
 *         → **반영 불필요.** 이 절에 걸리는 행(= 이미 파기된 행)은 예측 경로에 도달하지 않는다.
 *            destroyed_at 실적으로 먼저 답하기 때문이다.
 *      5) (expireAt IS NULL OR DATE(expireAt) < DATE(now) OR deletedAt IS NOT NULL)
 *         → 반영. 유효기간 가드.
 *
 *    ⇒ 3) 때문에 예측값은 **배치가 파기할 수 있는 가장 이른 날짜**(하한)이지 확정이 아니다.
 *      배치 회차가 유실되거나 주문이 DELIVERY_COMPLETE 를 이탈하면(외부 API 취소 등) 더
 *      늦어지거나 아예 파기되지 않는데도 날짜는 계속 표시된다. 실적(destroyed_at)과 성격이
 *      다르다는 점을 응답 DTO 설명에도 명시해 두었다.
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
 * 판정 순서와 각 분기의 의미:
 *
 * ★ 판정 순서가 이 함수의 핵심이다 — **"지금 지워져 있나"를 "언제 지웠나"보다 먼저 묻는다.**
 *
 *   두 질문은 원래 같은 말이었다. 한 번 지우면 끝이니 구분할 필요가 없었다. 그런데 CS 사후
 *   대응을 위해 **파기된 발송건의 수신처를 다시 채워 넣는 경로가 열려 있다**
 *   (customer.service.service.ts 의 수신정보 변경 — 운영상 의도된 동작이다). 그 순간 둘이 갈린다:
 *     · destroyedAt      = 과거에 지웠다는 **기록**
 *     · deliveryTarget   = 지금 지워져 있는지의 **현재 상태**
 *   도서관 반납 기록과 같다. "6/30 반납" 기록이 있어도 그 뒤 다시 빌려갔으면 지금은 대출 중이다.
 *   기록이 틀린 게 아니라 질문이 다른 것이다.
 *
 *   그래서 destroyedAt 을 먼저 보면 안 된다. 먼저 보면 재입력된 행에서 살아있는 수신처 옆에
 *   "파기일 2026-06-30"이 나란히 인쇄된다 — 한 장의 문서에 모순이 찍힌다.
 *
 *  ① 지금 살아있다(deliveryTarget != '-') → **예정일**. 배치 규칙을 날짜로 옮겨 계산한다.
 *     = MAX(DATE(발송요청일) + 파기일수, 유효기간 만료일 + 1일)
 *     유효기간 가드가 적용되는 건(= 유효기간이 아직 남은 건)만 만료 다음 날까지 미뤄진다.
 *     가드 비적용 2종(유효기간 없음 / soft-delete)은 기준일 그대로다. 쿠폰 상태(USED·CANCEL 등)는
 *     판정에 쓰지 않는다 — 유효기간이 남아 있으면 사용 완료된 쿠폰도 보류한다.
 *     ⚠️ 여기에는 **destroyedAt 이 있는데 수신처가 되살아난 행**도 포함된다. 그 행은 다음 배치
 *        회차에 다시 파기되므로 예정일이 정답이고, 배치는 그때 destroyedAt 을 새 날짜로 갱신한다
 *        (delivery.batch.service.ts 의 각인 분기 참조). 과거 기록을 표시하지 않는 것이 핵심이다.
 *
 *  ② 지워져 있고 destroyed_at 이 있다 → **실적**. 정기·조기 어느 경로로 지웠든 그 시점이다.
 *     계산을 일절 하지 않는다. 규칙이 나중에 또 바뀌어도 이 값은 흔들리지 않는다.
 *
 *  ③ 지워져 있는데 destroyed_at 이 없다 → **파기됐는데 시각을 모른다** → null.
 *     정상 운영에서는 나오지 않아야 하는 조합이다. 도달 경로는 둘뿐이다:
 *       · 컬럼 신설 백필에서 기준 컬럼(sendRequestAt / requestToDestroyPersonalInfoDay)이
 *         결측이라 값을 못 채운 행
 *       · 백필을 돌리기 전에 코드가 먼저 배포된 경우(배포 순서 사고)
 *     여기서 예정일로 폴백하면 안 된다 — 그게 바로 H-1(이미 지운 건에 미래 날짜)의 재현이다.
 *     "모른다"를 null 로 정직하게 표현한다.
 *
 * deletedAt 분기는 발송완료 보고서 경로에서는 사실상 도달하지 않는다 — soft-delete 되는 것은
 * 되감긴 tip 뿐이고 tip 은 replacedFromId 가 있어 호출부가 먼저 걸러내는 경우가 많다. 배치와의
 * 규칙 대조를 위해 남긴 방어 분기다.
 * null 판정이 expireAt(=== null && === undefined)과 deletedAt(=== null)에서 비대칭인 점에 주의.
 * 부분 select/DTO 투영으로 deletedAt 이 undefined 로 들어오면 가드가 조용히 꺼져 실제보다 이른
 * 날짜가 나온다. 엔티티를 그대로 넘기면(현 호출부) @DeleteDateColumn 이 항상 선택되어 안전하다.
 */
export function resolveDeliveryDestroyAt(
  delivery: Pick<OrderDeliveryEntity, 'expireAt' | 'deletedAt' | 'deliveryTarget' | 'destroyedAt'>,
  sendRequestAt: Date | null | undefined,
  destroyDay: number | null | undefined,
): Date | null {
  // ★ 현재 상태를 먼저 묻는다. destroyedAt 을 먼저 보면 수신처가 되살아난 행에서
  //   살아있는 PII 옆에 과거 파기일이 인쇄된다(위 판정 순서 설명 참조).
  if (delivery.deliveryTarget === DESTROY_VALUE) {
    // ② 지워져 있고 기록이 있다 → 실적.
    if (delivery.destroyedAt) return atStartOfDay(delivery.destroyedAt);
    // ③ 지워져 있는데 기록이 없다 → 모른다. 예정일로 폴백하면 미래 날짜 인쇄가 재현된다.
    return null;
  }

  // ① 여기부터 예정일 계산 (지금 살아있는 행).
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
 * "전부 파기됨"이라 고지할 수 없다. 위 ②(파기됐는데 시각 모름)도 여기에 걸려 주문 전체가
 * null 이 되는데, 의도된 동작이다. 한 건이라도 근거가 없으면 주문 단위 진술도 성립하지 않는다.
 *
 * 그 보장은 **넘겨받은 집합에 한정**된다. 호출부가 발송건을 걸러낸 뒤 넘기면 걸러진 건은 MAX 에
 * 들어가지 않는다. 위 ⚠️ 대로 hideDiscardReissueDeliveries 적용 전 집합을 넘겨야 하는 이유다.
 *
 * 일부만 조기파기된 주문에서는 실적일과 예정일이 섞여 MAX 를 이루는데, 그래도 "이 날이면 전부
 * 지워져 있다"는 의미는 유지된다 — 실적일은 이미 지난 날이고 예정일은 앞으로 올 날이라, 둘을
 * 섞어 최댓값을 잡아도 "그 시점엔 전부 정리됨"이 성립하기 때문이다.
 * (다만 "실적일은 MAX 에 영향을 주지 않는다"고 단정하지는 말 것 — 발송건이 **전부** 파기된
 *  주문에서는 MAX 가 곧 실적일이다. 발송건 1건짜리 주문이 그 대표 사례다.)
 */
export function resolveOrderEffectiveDestroyAt(order: Pick<OrderEntity, 'orderProductMappings'>): Date | null {
  const mappings: OrderProductMappingEntity[] = order.orderProductMappings ?? [];

  let latest: Date | null = null;

  for (const mapping of mappings) {
    for (const delivery of mapping.orderDeliveries ?? []) {
      const destroyAt = resolveDeliveryDestroyAt(
        delivery,
        mapping.sendRequestAt,
        mapping.requestToDestroyPersonalInfoDay,
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
