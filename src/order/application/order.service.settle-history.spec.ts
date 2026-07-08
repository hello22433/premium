import { OrderService } from './order.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { SettleDiscountChangeSource } from '../domain/settle.discount.history';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IOrderStatus } from '../interface/order.status';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

describe('OrderService 정산 변경이력 로깅', () => {
  const createService = () => {
    const service = Object.create(OrderService.prototype) as any;
    service.activityLogService = { createLog: jest.fn().mockResolvedValue(1) };
    return service;
  };

  const user = { id: 42, email: 'op@test.com' } as any;

  describe('captureSettleSnapshot', () => {
    it('mutate 이전 값을 보존하고 상품명을 함께 캡처한다', () => {
      const service = createService();
      const mapping = {
        id: 10,
        fee: null,
        priceAdjustment: null,
        settleDiscountType: null,
        product: { name: '상품A' },
      };

      const { beforeById, productNameById } = service.captureSettleSnapshot([mapping]);

      // 캡처 후 엔티티를 mutate 해도 스냅샷은 원본값을 유지한다.
      mapping.fee = 7 as any;
      mapping.priceAdjustment = IPriceAdjustment.DISCOUNT as any;

      expect(beforeById.get(10)).toEqual({ fee: null, priceAdjustment: null, settleDiscountType: null });
      expect(productNameById.get(10)).toBe('상품A');
    });
  });

  describe('logSettleDiscountChange', () => {
    it('운영자(user)가 없으면 기록하지 않는다', async () => {
      const service = createService();
      await service.logSettleDiscountChange({
        user: undefined,
        orderId: 1,
        requestUrl: '/order/settle',
        method: 'POST',
        source: SettleDiscountChangeSource.MANUAL,
        changes: [{ mappingId: 10, productName: null, before: {} as any, after: {} as any }],
      });
      expect(service.activityLogService.createLog).not.toHaveBeenCalled();
    });

    it('변경(매핑/주문)이 전혀 없으면 기록하지 않는다', async () => {
      const service = createService();
      await service.logSettleDiscountChange({
        user,
        orderId: 1,
        requestUrl: '/order/settle',
        method: 'POST',
        source: SettleDiscountChangeSource.MANUAL,
        changes: [],
        orderBefore: { settleMethod: 'CARD', cardSurchargeApplied: true },
        orderAfter: { settleMethod: 'CARD', cardSurchargeApplied: true, settleAmount: 1000 },
      });
      expect(service.activityLogService.createLog).not.toHaveBeenCalled();
    });

    it('수동 변경 시 SETTLE_DISCOUNT_MODIFY 로 운영자·변경목록·주문블록을 기록한다', async () => {
      const service = createService();
      const changes = [
        {
          mappingId: 10,
          productName: '상품A',
          before: { fee: null, priceAdjustment: null, settleDiscountType: null },
          after: { fee: 7, priceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: null },
        },
      ];

      await service.logSettleDiscountChange({
        user,
        orderId: 55,
        requestUrl: '/order/settle',
        method: 'PUT',
        source: SettleDiscountChangeSource.MANUAL,
        changes,
        orderBefore: { settleMethod: 'CASH', cardSurchargeApplied: false },
        orderAfter: { settleMethod: 'CARD', cardSurchargeApplied: true, settleAmount: 9000 },
      });

      expect(service.activityLogService.createLog).toHaveBeenCalledTimes(1);
      expect(service.activityLogService.createLog).toHaveBeenCalledWith({
        userId: 42,
        userEmail: 'op@test.com',
        method: 'PUT',
        requestUrl: '/order/settle',
        actionType: ActivityLogActionType.SETTLE_DISCOUNT_MODIFY,
        ipAddress: '',
        statusCode: 200,
        result: ActivityLogResult.SUCCESS,
        responseTime: 0,
        requestParams: {
          orderId: 55,
          source: SettleDiscountChangeSource.MANUAL,
          changes,
          order: {
            before: { settleMethod: 'CASH', cardSurchargeApplied: false },
            after: { settleMethod: 'CARD', cardSurchargeApplied: true, settleAmount: 9000 },
          },
        },
      });
    });

    it('자동캡처는 SETTLE_DISCOUNT_AUTO_CAPTURE 로 기록하고 주문블록은 넣지 않는다', async () => {
      const service = createService();
      const changes = [
        {
          mappingId: 10,
          productName: '상품A',
          before: { fee: null, priceAdjustment: null, settleDiscountType: null },
          after: { fee: 7, priceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: null },
        },
      ];

      await service.logSettleDiscountChange({
        user,
        orderId: 55,
        requestUrl: '/order/delivery-confirmed',
        method: 'POST',
        source: SettleDiscountChangeSource.AUTO_CONFIRM,
        changes,
      });

      const arg = service.activityLogService.createLog.mock.calls[0][0];
      expect(arg.actionType).toBe(ActivityLogActionType.SETTLE_DISCOUNT_AUTO_CAPTURE);
      expect(arg.requestParams.source).toBe(SettleDiscountChangeSource.AUTO_CONFIRM);
      expect(arg.requestParams.order).toBeUndefined();
      expect(arg.requestParams.changes).toEqual(changes);
    });
  });
  describe('createOrderSettle delivery-scoped 부분 변경 회귀', () => {
    beforeAll(() => {
      initializeTransactionalContext();
      deleteDataSourceByName('default');
      addTransactionalDataSource({
        name: 'default',
        patch: false,
        dataSource: {
          transaction: async (...args: any[]) => {
            const callback = typeof args[0] === 'function' ? args[0] : args[1];
            return callback({});
          },
        } as any,
      });
    });

    afterAll(() => deleteDataSourceByName('default'));

    it('같은 상품의 delivery 2건을 서로 다른 fee로 저장하면 mapping 대표값 미동기화여도 deliveryChanges로 createLog가 호출된다', async () => {
      const order = {
        id: 77,
        userId: 1,
        clientUserId: 2,
        sendAmount: 20000,
        settleAmount: 20000,
        cardSurchargeApplied: false,
        settleMethod: 'CASH',
        isNewBillingFlow: true,
        isSettleBalance: false,
        status: IOrderStatus.REVIEW_COMPLETE,
      };
      const mapping = {
        id: 10,
        orderId: 77,
        order,
        amount: 2,
        fee: null,
        priceAdjustment: null,
        settleDiscountType: null,
        product: { price: 10000, name: '상품A' },
        orderDeliveries: [
          { id: 1, settleFee: null, settlePriceAdjustment: null, settleDiscountType: null },
          { id: 2, settleFee: null, settlePriceAdjustment: null, settleDiscountType: null },
        ],
      };
      const queryBuilder = {
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([mapping]),
      };
      const service = Object.create(OrderService.prototype) as any;
      service.activityLogService = { createLog: jest.fn().mockResolvedValue(1) };
      service.orderProductMappingRepository = {
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        save: jest.fn(),
      };
      service.orderDeliveryRepository = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
      service.orderRepository = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
      service.userRepository = { findOne: jest.fn().mockResolvedValue({ company: { settleMethod: 'CASH' } }) };
      service.resolveSettlePolicy = jest.fn().mockResolvedValue({ policy: 'CASH' });
      service.logger = { debug: jest.fn(), warn: jest.fn(), log: jest.fn() };

      await service.createOrderSettle(
        {
          list: [
            { id: 10, fee: 5, deliveryIds: [1] },
            { id: 10, fee: 10, deliveryIds: [2] },
          ],
        } as any,
        user,
      );

      expect(service.activityLogService.createLog).toHaveBeenCalledTimes(1);
      const arg = service.activityLogService.createLog.mock.calls[0][0];
      expect(arg.actionType).toBe(ActivityLogActionType.SETTLE_DISCOUNT_MODIFY);
      // mapping 대표값이 동기화되지 않으므로 mapping-level changes 는 비어야 하고,
      expect(arg.requestParams.changes).toEqual([]);
      // delivery-level 로 2건 모두 잡혀야 한다.
      expect(arg.requestParams.deliveryChanges).toHaveLength(2);
      expect(arg.requestParams.deliveryChanges.map((c: any) => [c.deliveryId, c.after.settleFee])).toEqual([
        [1, 5],
        [2, 10],
      ]);
    });
  });
});
