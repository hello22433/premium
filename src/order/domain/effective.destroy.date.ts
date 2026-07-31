import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { isDeliveryDestroyed, isEstimatedDestroyedAt } from './destroyed.at.source';

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
 *   · **지금** 살아있는 행 → "언제 지울까" = **예측**. 배치 규칙을 날짜로 옮겨 계산한다.
 *     (한 번 파기됐다가 CS 수신정보 변경으로 되살아난 행도 여기 들어온다 — 축은 '과거에
 *      지운 적이 있나'가 아니라 '지금 지워져 있나'다.)
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
 *         → **부분 반영.** 이 함수가 "지금 지워져 있나"로 먼저 갈라내므로(아래 판정 순서),
 *            완전히 지워진 행은 예측 경로에 도달하지 않는다. 그러나 술어(isDeliveryDestroyed)는
 *            deliveryTarget + emailReceiverPhone **2종**이고 배치의 재수집 절은 **5종**이라
 *            둘이 정확히 겹치지 않는다. 그래서 아래 두 종류는 예측 경로에 **도달한다**:
 *              · 부활 행 — CS 수신정보 변경으로 emailReceiverPhone 만 되살아난 행
 *              · 레거시 부분마스킹 행 — PII 5종 확대 이전에 일부만 마스킹된 행
 *            둘 다 "아직 안 지워짐"이 맞는 판정이므로 예정일을 답하는 것 자체는 정확하다.
 *            다만 파기확인서 게이트는 deliveryTarget 단일 판정이라 같은 행을 "발행 가능"으로
 *            보므로, 서버가 두 답을 동시에 낸다(리뷰 3차 H-1). 그 조합의 처리는 게이트 쪽에
 *            있어야 하며 여기서 날짜를 왜곡해 맞추지 않는다.
 *            그리고 완전히 지워진 행이라도 항상 실적을 돌려주는 것은 아니다 — 기록이 없으면 null.
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
 * 파기일의 **성격**. 같은 `yyyy-MM-dd` 문자열이라도 근거의 강도가 다르므로, 날짜와 함께
 * 반드시 이 값을 들고 다닌다. 대외 증빙(파기확인서)에 실리는 값이라 "이 날짜가 사실입니까"에
 * 답할 수 있어야 하고, 날짜만으로는 답할 수 없기 때문이다.
 *
 *  · ACTUAL           이미 파기됐고 그 시각이 **기록**돼 있다. 가장 강하다.
 *  · ACTUAL_ESTIMATED 이미 파기됐지만 시각은 **추정**이다(컬럼 신설 백필 §3 이 옛 규칙으로 역산).
 *                     날짜는 그럴듯하지만 실측이 아니므로 증빙에 쓸 때 주의가 필요하다.
 *  · SCHEDULED        아직 파기되지 않았다. 배치가 파기할 수 있는 **가장 이른 날**(하한)이다.
 *
 * 확실성 순서: ACTUAL > ACTUAL_ESTIMATED > SCHEDULED.
 */
export type EffectiveDestroyAtKind = 'ACTUAL' | 'ACTUAL_ESTIMATED' | 'SCHEDULED';

/** 주문/발송건 단위 확실성 비교용. 숫자가 클수록 근거가 강하다. */
export const KIND_CERTAINTY: Record<EffectiveDestroyAtKind, number> = {
  ACTUAL: 3,
  ACTUAL_ESTIMATED: 2,
  SCHEDULED: 1,
};

/** 파기일 + 그 근거의 성격. 날짜만 떼어 쓰면 성격이 유실되므로 항상 쌍으로 다룬다. */
export interface EffectiveDestroyAt {
  at: Date;
  kind: EffectiveDestroyAtKind;
}

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
 *     정상 운영에서는 나오지 않아야 하는 조합이다. **알려진** 도달 경로는 셋이다
 *     (초기 주석은 "둘뿐이다"라고 단정한 뒤 셋을 나열했다 — 리뷰 4차에서 지적받아 정정):
 *       · 컬럼 신설 백필에서 기준 컬럼(sendRequestAt / requestToDestroyPersonalInfoDay)이
 *         결측이라 값을 못 채운 행
 *       · 백필을 돌리기 전에 코드가 먼저 배포된 경우(배포 순서 사고)
 *       · **각인 경로가 마스킹 대상 집합을 놓친 경우** — 마스킹은 됐는데 각인이 안 된 행이다.
 *         (조기파기가 soft-delete 행을 조회에서 빠뜨렸던 것이 실제 사례다. 각인 UPDATE 는
 *          soft-delete 필터가 안 붙어 그 행까지 마스킹하는데 대상 목록에는 없었다.)
 *     ⇒ **이 열거는 완결이 아니다.** 이 상태가 보이면 각인 경로 중 하나가 집합을 놓쳤다고
 *       보고 조사해야 한다 — 마이그레이션 잔여물로 단정하면 진짜 결함을 놓친다.
 *     ⚠️ 이 분기는 이제 **표시뿐 아니라 파기확인서 발행까지 좌우한다.** 게이트가 주문 파기일이
 *       null 이면 DESTROY_TIME_UNKNOWN 으로 발행을 막기 때문이다
 *       (destruction.certificate.gate.ts). 여기 한 건이 걸리면 그 주문 전체가 막힌다.
 *     여기서 예정일로 폴백하면 안 된다 — 그게 바로 H-1(이미 지운 건에 미래 날짜)의 재현이다.
 *     "모른다"를 null 로 정직하게 표현한다.
 *
 * deletedAt 분기는 **실제로 도달한다.** soft-delete 되는 것은 되감긴 tip 뿐인데, 이 함수는
 * hideDiscardReissueDeliveries **이전** 집합을 받도록 계약돼 있어(위 ⚠️) tip 이 반드시 포함된다.
 * 방어 분기가 아니라 정상 경로이므로 지우면 안 된다.
 * null 판정이 expireAt(=== null && === undefined)과 deletedAt(=== null)에서 비대칭인 점에 주의.
 * 부분 select/DTO 투영으로 deletedAt 이 undefined 로 들어오면 가드가 조용히 꺼져 실제보다 이른
 * 날짜가 나온다. 엔티티를 그대로 넘기면(현 호출부) @DeleteDateColumn 이 항상 선택되어 안전하다.
 */
export function resolveDeliveryDestroyAt(
  delivery: Pick<
    OrderDeliveryEntity,
    'expireAt' | 'deletedAt' | 'deliveryTarget' | 'destroyedAt' | 'destroyedAtSource' | 'emailReceiverPhone'
  >,
  sendRequestAt: Date | null | undefined,
  destroyDay: number | null | undefined,
): EffectiveDestroyAt | null {
  // ★ 현재 상태를 먼저 묻는다. destroyedAt 을 먼저 보면 수신처가 되살아난 행에서
  //   살아있는 PII 옆에 과거 파기일이 인쇄된다(위 판정 순서 설명 참조).
  if (isDeliveryDestroyed(delivery)) {
    // ② 지워져 있고 기록이 있다 → 실적. 다만 그 값이 사실인지 추정인지는 출처가 가른다.
    if (delivery.destroyedAt) {
      return {
        at: atStartOfDay(delivery.destroyedAt),
        kind: isEstimatedDestroyedAt(delivery.destroyedAtSource) ? 'ACTUAL_ESTIMATED' : 'ACTUAL',
      };
    }
    // ③ 지워져 있는데 기록이 없다 → 모른다. 예정일로 폴백하면 미래 날짜 인쇄가 재현된다.
    return null;
  }

  // ① 여기부터 예정일 계산 (지금 살아있는 행).
  // 배치 주 절이 INTERVAL NULL DAY → NULL 이 되어 이 행을 영원히 집지 않는다. 파기일을 특정할
  // 수 없으므로 null. (실제로 파기되지 않는 상태이므로 날짜를 지어내면 거짓 고지가 된다.)
  if (!sendRequestAt || destroyDay === null || destroyDay === undefined) return null;

  const baseDestroyAt = addDays(atStartOfDay(sendRequestAt), destroyDay);

  const guardApplies = delivery.expireAt !== null && delivery.expireAt !== undefined && delivery.deletedAt === null;

  if (!guardApplies) return { at: baseDestroyAt, kind: 'SCHEDULED' };

  // 만료 당일은 아직 유효하므로 다음 날 회차에서 파기된다 — 배치의 `DATE(expireAt) < DATE(now)`.
  const expiryDestroyAt = addDays(atStartOfDay(delivery.expireAt as Date), 1);

  return { at: expiryDestroyAt > baseDestroyAt ? expiryDestroyAt : baseDestroyAt, kind: 'SCHEDULED' };
}

/**
 * 주문 전체가 파기 완료되는 날짜 = 소속 발송건 파기일의 MAX.
 *
 * 보고서·화면은 주문 단위로 날짜 하나를 보여주는데, 발송건마다 expireAt 이 다를 수 있다.
 * "이 날이면 전부 지워져 있다"를 보장해야 고지로서 의미가 있으므로 최댓값을 쓴다.
 *
 * 파기일을 특정할 수 없는 발송건(null)이 하나라도 있으면 주문 전체도 null 이다 — 일부만 보고
 * "전부 파기됨"이라 고지할 수 없다. 위 ③(파기됐는데 시각 모름)도 여기에 걸려 주문 전체가
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
export function resolveOrderEffectiveDestroyAt(
  order: Pick<OrderEntity, 'orderProductMappings'>,
): EffectiveDestroyAt | null {
  const mappings: OrderProductMappingEntity[] = order.orderProductMappings ?? [];

  let latest: Date | null = null;
  let weakest: EffectiveDestroyAtKind = 'ACTUAL';

  for (const mapping of mappings) {
    for (const delivery of mapping.orderDeliveries ?? []) {
      const resolved = resolveDeliveryDestroyAt(
        delivery,
        mapping.sendRequestAt,
        mapping.requestToDestroyPersonalInfoDay,
      );
      // 특정 불가한 건이 하나가 있으면 주문 전체를 특정할 수 없다.
      if (resolved === null) return null;
      if (latest === null || resolved.at > latest) latest = resolved.at;
      // ★ kind 는 MAX 날짜의 것이 아니라 **가장 약한 것**을 택한다.
      //   "이 날이면 전부 지워져 있다"는 진술은 구성 요소 중 가장 불확실한 것만큼만 강하다.
      //   실적 하나 + 예정 하나면 주문 전체는 예정이고, 실적 하나 + 추정 하나면 추정이다.
      if (KIND_CERTAINTY[resolved.kind] < KIND_CERTAINTY[weakest]) weakest = resolved.kind;
    }
  }

  // 발송건이 하나도 없으면 초기값 null 이 그대로 나간다 — "증명할 내용이 없다"와 같은 뜻이다.
  // (발송건이 있으면 위 루프에서 최소 1회 갱신되므로 여기서 latest 는 반드시 non-null 이다.)
  return latest === null ? null : { at: latest, kind: weakest };
}
