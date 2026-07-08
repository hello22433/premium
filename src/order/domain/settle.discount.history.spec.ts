import {
  buildSettleDiscountChanges,
  buildSettleDeliveryChanges,
  isSettleDeliveryChanged,
  isSettleFieldChanged,
  isSettleOrderChanged,
  SETTLE_DISCOUNT_SOURCE_ACTION_TYPE,
  SettleDiscountChangeSource,
  SettleFieldSnapshot,
} from './settle.discount.history';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IOrderSettleDiscountType } from '../interface/order.settle.discount.type';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';

const snap = (overrides: Partial<SettleFieldSnapshot> = {}): SettleFieldSnapshot => ({
  fee: null,
  priceAdjustment: null,
  settleDiscountType: null,
  ...overrides,
});

describe('settle.discount.history', () => {
  describe('isSettleFieldChanged', () => {
    it('세 필드가 모두 같으면 false', () => {
      expect(isSettleFieldChanged(snap({ fee: 10 }), snap({ fee: 10 }))).toBe(false);
    });

    it('fee/priceAdjustment/settleDiscountType 중 하나라도 다르면 true', () => {
      expect(isSettleFieldChanged(snap({ fee: 10 }), snap({ fee: 20 }))).toBe(true);
      expect(isSettleFieldChanged(snap(), snap({ priceAdjustment: IPriceAdjustment.DISCOUNT }))).toBe(true);
      expect(isSettleFieldChanged(snap(), snap({ settleDiscountType: IOrderSettleDiscountType.ONE }))).toBe(true);
    });
  });

  describe('isSettleOrderChanged', () => {
    it('결제수단/카드할증이 동일하면 false', () => {
      expect(
        isSettleOrderChanged(
          { settleMethod: 'CARD', cardSurchargeApplied: true },
          { settleMethod: 'CARD', cardSurchargeApplied: true },
        ),
      ).toBe(false);
    });

    it('결제수단 또는 카드할증이 바뀌면 true', () => {
      expect(
        isSettleOrderChanged(
          { settleMethod: 'CARD', cardSurchargeApplied: true },
          { settleMethod: 'CASH', cardSurchargeApplied: true },
        ),
      ).toBe(true);
      expect(
        isSettleOrderChanged(
          { settleMethod: 'CARD', cardSurchargeApplied: true },
          { settleMethod: 'CARD', cardSurchargeApplied: false },
        ),
      ).toBe(true);
    });
  });

  describe('buildSettleDiscountChanges', () => {
    it('실제로 값이 바뀐 매핑만 change 로 만든다', () => {
      const before = new Map<number, SettleFieldSnapshot>([
        [10, snap({ fee: null })],
        [11, snap({ fee: 5 })],
      ]);
      const productNames = new Map<number, string>([[10, '상품A']]);

      const changes = buildSettleDiscountChanges(
        before,
        [
          { id: 10, fee: 7, priceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: null },
          { id: 11, fee: 5, priceAdjustment: null, settleDiscountType: null }, // 변경 없음
        ],
        productNames,
      );

      expect(changes).toEqual([
        {
          mappingId: 10,
          productName: '상품A',
          before: { fee: null, priceAdjustment: null, settleDiscountType: null },
          after: { fee: 7, priceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: null },
        },
      ]);
    });

    it('before 스냅샷에 없는 매핑은 무시하고, 상품명이 없으면 null 로 둔다', () => {
      const before = new Map<number, SettleFieldSnapshot>([[10, snap({ fee: null })]]);

      const changes = buildSettleDiscountChanges(
        before,
        [
          { id: 10, fee: 7, priceAdjustment: null, settleDiscountType: null },
          { id: 99, fee: 1, priceAdjustment: null, settleDiscountType: null }, // before 없음 → 무시
        ],
        new Map(),
      );

      expect(changes).toHaveLength(1);
      expect(changes[0].mappingId).toBe(10);
      expect(changes[0].productName).toBeNull();
    });
  });

  describe('SETTLE_DISCOUNT_SOURCE_ACTION_TYPE', () => {
    it('source 별 actionType 매핑', () => {
      expect(SETTLE_DISCOUNT_SOURCE_ACTION_TYPE[SettleDiscountChangeSource.MANUAL]).toBe(
        ActivityLogActionType.SETTLE_DISCOUNT_MODIFY,
      );
      expect(SETTLE_DISCOUNT_SOURCE_ACTION_TYPE[SettleDiscountChangeSource.AUTO_CONFIRM]).toBe(
        ActivityLogActionType.SETTLE_DISCOUNT_AUTO_CAPTURE,
      );
    });
  });
  describe('isSettleDeliveryChanged', () => {
    it('세 필드 동일하면 false, 하나라도 다르면 true', () => {
      const base = { settleFee: 5, settlePriceAdjustment: null, settleDiscountType: null };
      expect(isSettleDeliveryChanged(base, { ...base })).toBe(false);
      expect(isSettleDeliveryChanged(base, { ...base, settleFee: 10 })).toBe(true);
    });
  });

  describe('buildSettleDeliveryChanges', () => {
    const before = new Map<number, { mappingId: number } & any>([
      [1, { mappingId: 10, settleFee: null, settlePriceAdjustment: null, settleDiscountType: null }],
      [2, { mappingId: 10, settleFee: null, settlePriceAdjustment: null, settleDiscountType: null }],
      [3, { mappingId: 11, settleFee: 5, settlePriceAdjustment: null, settleDiscountType: null }],
    ]);
    const mappings = [
      {
        id: 10,
        orderDeliveries: [
          { id: 1, settleFee: 5, settlePriceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: null },
          { id: 2, settleFee: 10, settlePriceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: null },
        ],
      },
      {
        id: 11,
        orderDeliveries: [{ id: 3, settleFee: 5, settlePriceAdjustment: null, settleDiscountType: null }], // 변경 없음
      },
    ];

    it('같은 상품의 delivery가 서로 다른 값으로 변경되면 delivery별로 각각 잡는다', () => {
      const changes = buildSettleDeliveryChanges(before, mappings, new Set(), new Map([[10, '상품A']]));
      expect(changes).toHaveLength(2);
      expect(changes.map((c) => c.deliveryId)).toEqual([1, 2]);
      expect(changes[0]).toMatchObject({
        mappingId: 10,
        deliveryId: 1,
        productName: '상품A',
        before: { settleFee: null, settlePriceAdjustment: null, settleDiscountType: null },
        after: { settleFee: 5, settlePriceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: null },
      });
    });

    it('mapping 대표값으로 이미 집계된 매핑(excludeMappingIds)은 delivery 중복 집계하지 않는다', () => {
      const changes = buildSettleDeliveryChanges(before, mappings, new Set([10]), new Map());
      expect(changes).toHaveLength(0); // 10 은 제외, 11 은 변경 없음
    });
  });
});
