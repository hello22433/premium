import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IOrderSettleDiscountType } from '../interface/order.settle.discount.type';

/** 정산 이력 기록 출처 (activity_log requestParams.source). */
export enum SettleDiscountChangeSource {
  /** 정산정보 입력/수정 API 를 통한 운영자 수동 변경 */
  MANUAL = 'MANUAL',
  /** 발송확정 시 user_discount 자동 매칭으로 캡처된 변경 */
  AUTO_CONFIRM = 'AUTO_CONFIRM',
}

/** 매핑(상품) 단위 정산 필드 스냅샷. */
export type SettleFieldSnapshot = {
  fee: number | null;
  priceAdjustment: IPriceAdjustment | null;
  settleDiscountType: IOrderSettleDiscountType | null;
};

/** 매핑별 before→after 변경. */
export type SettleDiscountChange = {
  mappingId: number;
  productName: string | null;
  before: SettleFieldSnapshot;
  after: SettleFieldSnapshot;
};

/** 주문 단위 결제수단/카드할증 스냅샷. */
export type SettleOrderSnapshot = {
  settleMethod: 'CARD' | 'CASH' | null;
  cardSurchargeApplied: boolean | null;
};

export const SETTLE_DISCOUNT_SOURCE_ACTION_TYPE: Record<SettleDiscountChangeSource, ActivityLogActionType> = {
  [SettleDiscountChangeSource.MANUAL]: ActivityLogActionType.SETTLE_DISCOUNT_MODIFY,
  [SettleDiscountChangeSource.AUTO_CONFIRM]: ActivityLogActionType.SETTLE_DISCOUNT_AUTO_CAPTURE,
};

/** 두 스냅샷이 fee/priceAdjustment/settleDiscountType 중 하나라도 다르면 true. */
export function isSettleFieldChanged(before: SettleFieldSnapshot, after: SettleFieldSnapshot): boolean {
  return (
    before.fee !== after.fee ||
    before.priceAdjustment !== after.priceAdjustment ||
    before.settleDiscountType !== after.settleDiscountType
  );
}

/** 주문 단위 결제수단/카드할증이 변경됐으면 true. */
export function isSettleOrderChanged(before: SettleOrderSnapshot, after: SettleOrderSnapshot): boolean {
  return before.settleMethod !== after.settleMethod || before.cardSurchargeApplied !== after.cardSurchargeApplied;
}

/**
 * before 스냅샷 맵과 after 값 목록을 비교해 실제 변경된 매핑만 change 목록으로 만든다.
 * @param beforeById 매핑ID → 변경 전 스냅샷 (정산 처리 전에 캡처)
 * @param afterList  변경 후 값 (처리 결과로 저장된 매핑들; 변경분만 담겨도 무방)
 * @param productNameById 매핑ID → 상품명 (표시용)
 */
export function buildSettleDiscountChanges(
  beforeById: Map<number, SettleFieldSnapshot>,
  afterList: Array<{ id: number } & SettleFieldSnapshot>,
  productNameById: Map<number, string>,
): SettleDiscountChange[] {
  const changes: SettleDiscountChange[] = [];
  for (const after of afterList) {
    const before = beforeById.get(after.id);
    if (!before) {
      continue;
    }
    const afterSnapshot: SettleFieldSnapshot = {
      fee: after.fee,
      priceAdjustment: after.priceAdjustment,
      settleDiscountType: after.settleDiscountType,
    };
    if (!isSettleFieldChanged(before, afterSnapshot)) {
      continue;
    }
    changes.push({
      mappingId: after.id,
      productName: productNameById.get(after.id) ?? null,
      before,
      after: afterSnapshot,
    });
  }
  return changes;
}

/** delivery(수신번호) 단위 정산 필드 스냅샷. */
export type SettleDeliverySnapshot = {
  settleFee: number | null;
  settlePriceAdjustment: IPriceAdjustment | null;
  settleDiscountType: IOrderSettleDiscountType | null;
};

/** delivery 단위 before→after 변경. */
export type SettleDeliveryChange = {
  mappingId: number;
  deliveryId: number;
  productName: string | null;
  before: SettleDeliverySnapshot;
  after: SettleDeliverySnapshot;
};

/** 정산 처리 전에 캡처하는 매핑/delivery before 스냅샷 묶음. */
export type SettleSnapshot = {
  beforeById: Map<number, SettleFieldSnapshot>;
  productNameById: Map<number, string>;
  deliveryBeforeById: Map<number, { mappingId: number } & SettleDeliverySnapshot>;
};

/** delivery 스냅샷이 settleFee/settlePriceAdjustment/settleDiscountType 중 하나라도 다르면 true. */
export function isSettleDeliveryChanged(before: SettleDeliverySnapshot, after: SettleDeliverySnapshot): boolean {
  return (
    before.settleFee !== after.settleFee ||
    before.settlePriceAdjustment !== after.settlePriceAdjustment ||
    before.settleDiscountType !== after.settleDiscountType
  );
}

/**
 * delivery(수신번호) 단위 before→after 변경 목록.
 * mapping 대표값이 동기화되지 않는 부분 변경(같은 상품의 일부 발송건만 다른 할인율로 저장)을 놓치지 않기 위해 사용.
 * @param beforeById        deliveryId → { mappingId, 변경 전 스냅샷 } (정산 처리 전에 캡처)
 * @param mappings          처리 후 delivery 값을 담은 매핑들(엔티티가 in-place mutate 됨)
 * @param excludeMappingIds mapping 대표값 변경으로 이미 집계된 매핑(중복 집계 방지)
 * @param productNameById   mappingId → 상품명
 */
export function buildSettleDeliveryChanges(
  beforeById: Map<number, { mappingId: number } & SettleDeliverySnapshot>,
  mappings: Array<{ id: number; orderDeliveries?: Array<{ id: number } & SettleDeliverySnapshot> | null }>,
  excludeMappingIds: Set<number>,
  productNameById: Map<number, string>,
): SettleDeliveryChange[] {
  const changes: SettleDeliveryChange[] = [];
  for (const mapping of mappings) {
    if (excludeMappingIds.has(mapping.id)) {
      continue;
    }
    for (const delivery of mapping.orderDeliveries ?? []) {
      const before = beforeById.get(delivery.id);
      if (!before) {
        continue;
      }
      const beforeSnapshot: SettleDeliverySnapshot = {
        settleFee: before.settleFee,
        settlePriceAdjustment: before.settlePriceAdjustment,
        settleDiscountType: before.settleDiscountType,
      };
      const afterSnapshot: SettleDeliverySnapshot = {
        settleFee: delivery.settleFee,
        settlePriceAdjustment: delivery.settlePriceAdjustment,
        settleDiscountType: delivery.settleDiscountType,
      };
      if (!isSettleDeliveryChanged(beforeSnapshot, afterSnapshot)) {
        continue;
      }
      changes.push({
        mappingId: mapping.id,
        deliveryId: delivery.id,
        productName: productNameById.get(mapping.id) ?? null,
        before: beforeSnapshot,
        after: afterSnapshot,
      });
    }
  }
  return changes;
}
