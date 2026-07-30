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
 *    배치 쿼리의 대응 절:
 *      DATE_ADD(DATE(sendRequestAt), INTERVAL requestToDestroyPersonalInfoDay DAY) <= DATE(now)
 *      AND (expireAt IS NULL OR DATE(expireAt) < DATE(now) OR deletedAt IS NOT NULL)
 *
 *    판정 기준은 쿠폰 상태가 아니라 유효기간 하나다 — 사용(USED)·폐기·환불폐기 여부와 무관하게
 *    유효기간이 남아 있으면 파기하지 않는다(운영 결정).
 *
 * 반환값은 시분초를 0 으로 절삭한 로컬(KST) 날짜다. 배치가 DATE() 단위로 비교하고 자정에 도는
 * 것과 맞춘다. 계산 불가(발송건 없음/기준 컬럼 결측)면 null 을 돌려주고, 호출부는 종전 표시로
 * 폴백한다 — 근거 없는 날짜를 지어내지 않는다.
 */

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
 * 발송건 1건의 파기예정일.
 *
 * 기준일 = DATE(발송요청일) + N일. 여기에 유효기간 가드가 적용되는 건(= 유효기간이 아직 남은
 * 건)만 만료 다음 날까지 미뤄진다. 가드 비적용 2종(유효기간 없음 / soft-delete)은 기준일
 * 그대로다. 쿠폰 상태(USED·CANCEL 등)는 판정에 쓰지 않는다 — 유효기간이 남아 있으면 사용
 * 완료된 쿠폰도 보류한다.
 *
 * 배치는 두 조건을 AND 로 묶으므로 실제 파기 최초 시점은 두 날짜의 MAX 다.
 */
export function resolveDeliveryDestroyAt(
  delivery: Pick<OrderDeliveryEntity, 'expireAt' | 'deletedAt'>,
  sendRequestAt: Date | null | undefined,
  destroyDay: number | null | undefined,
): Date | null {
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
 */
export function resolveOrderEffectiveDestroyAt(order: Pick<OrderEntity, 'orderProductMappings'>): Date | null {
  const mappings: OrderProductMappingEntity[] = order.orderProductMappings ?? [];

  let latest: Date | null = null;
  let hasDelivery = false;

  for (const mapping of mappings) {
    for (const delivery of mapping.orderDeliveries ?? []) {
      hasDelivery = true;
      const destroyAt = resolveDeliveryDestroyAt(
        delivery,
        mapping.sendRequestAt,
        mapping.requestToDestroyPersonalInfoDay,
      );
      if (destroyAt === null) return null;
      if (latest === null || destroyAt > latest) latest = destroyAt;
    }
  }

  return hasDelivery ? latest : null;
}
