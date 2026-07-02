jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IProductType } from '../../product/interface/product.type';

/**
 * ssgCouponExpireChange() 검증
 * #16 의심포인트 해소 확인:
 *  1. 기존 이벤트 가차감(isTemporary=true) 복원 호출
 *  2. 새 유효기간 이벤트 재할당 + 가차감 호출
 *  3. orderDelivery.ssgEventId 재저장
 *  4. order.ssgEventId 재저장
 */

const makeDelivery = (id: number, ssgEventId: number | null = null) => ({
  id,
  ssgEventId,
});

const makeMapping = (
  id: number,
  productPrice: number,
  sendType: string,
  sendRequestAt: Date | null,
  deliveries: ReturnType<typeof makeDelivery>[],
) => ({
  id,
  productId: 10,
  sendType,
  sendRequestAt,
  product: { price: productPrice, expireDay: 90, type: IProductType.SSG },
  orderDeliveries: deliveries,
});

const makeOrder = (mappings: ReturnType<typeof makeMapping>[]) => ({
  id: 1,
  type: IOrderType.SSG,
  status: IOrderStatus.DELIVERY_REQUEST,
  sendAmount: 10000,
  ssgEventId: 5,
  orderProductMappings: mappings,
});

const buildSut = (
  overrides: {
    allocations?: { deliveryId: number; eventId: number; price: number }[] | null;
    afterProducts?: any[];
  } = {},
) => {
  const afterProducts = overrides.afterProducts ?? [{ id: 20, price: 10000, expireDay: 60, type: IProductType.SSG }];
  const allocations =
    overrides.allocations !== undefined ? overrides.allocations : [{ deliveryId: 100, eventId: 99, price: 10000 }];

  const mappings = [makeMapping(1, 10000, 'RESERVE', new Date('2026-07-01T09:00:00'), [makeDelivery(100, 5)])];
  const order = makeOrder(mappings);

  const orderQb: any = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(order),
  };
  const orderRepository: any = {
    createQueryBuilder: jest.fn().mockReturnValue(orderQb),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const productRepository: any = {
    find: jest.fn().mockResolvedValue(afterProducts),
  };

  const orderProductMappingRepository: any = {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const orderDeliveryRepository: any = {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const restoreTemporaryEventBalance = jest.fn().mockResolvedValue(undefined);
  const allocateEventsForDeliveries = jest.fn().mockResolvedValue(allocations);
  const deductEventBalanceMultiple = jest.fn().mockResolvedValue(undefined);
  const hasOpenTempDeduction = jest.fn().mockResolvedValue(true);
  const lockEventsForCouponExpireChange = jest.fn().mockResolvedValue(undefined);

  const ssgEventService: any = {
    restoreTemporaryEventBalance,
    allocateEventsForDeliveries,
    deductEventBalanceMultiple,
    hasOpenTempDeduction,
    lockEventsForCouponExpireChange,
  };

  const sut: any = Object.create(OrderService.prototype);
  sut.orderRepository = orderRepository;
  sut.productRepository = productRepository;
  sut.orderProductMappingRepository = orderProductMappingRepository;
  sut.orderDeliveryRepository = orderDeliveryRepository;
  sut.ssgEventService = ssgEventService;

  return {
    sut,
    ssgEventService,
    orderRepository,
    orderDeliveryRepository,
    restoreTemporaryEventBalance,
    allocateEventsForDeliveries,
    deductEventBalanceMultiple,
    hasOpenTempDeduction,
    lockEventsForCouponExpireChange,
  };
};

const BASE_USER = { id: 1 } as any;
const BASE_BODY = { id: 1, couponExpiration: 60 };

describe('OrderService.ssgCouponExpireChange — #16 의심포인트 해소 검증', () => {
  describe('1. 기존 이벤트 가차감 복원', () => {
    it('restoreTemporaryEventBalance가 orderId로 호출된다', async () => {
      const { sut, restoreTemporaryEventBalance } = buildSut();
      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);
      expect(restoreTemporaryEventBalance).toHaveBeenCalledTimes(1);
      expect(restoreTemporaryEventBalance).toHaveBeenCalledWith(1);
    });
  });

  describe('2. 새 유효기간 이벤트 재할당 + 가차감', () => {
    it('allocateEventsForDeliveries가 새 couponExpiration으로 호출된다', async () => {
      const { sut, allocateEventsForDeliveries } = buildSut();
      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);
      expect(allocateEventsForDeliveries).toHaveBeenCalledTimes(1);
      const [deliveries, couponExpiration] = allocateEventsForDeliveries.mock.calls[0];
      expect(couponExpiration).toBe(60);
      expect(deliveries).toEqual(expect.arrayContaining([expect.objectContaining({ deliveryId: 100 })]));
    });

    it('deductEventBalanceMultiple이 allocations와 orderId로 호출된다', async () => {
      const { sut, deductEventBalanceMultiple } = buildSut();
      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);
      expect(deductEventBalanceMultiple).toHaveBeenCalledTimes(1);
      expect(deductEventBalanceMultiple).toHaveBeenCalledWith(
        [{ deliveryId: 100, eventId: 99, price: 10000 }],
        1,
        true,
      );
    });

    it('allocateEventsForDeliveries가 null 반환하면 BadRequestException 발생', async () => {
      const { sut } = buildSut({ allocations: null });
      await expect(sut.ssgCouponExpireChange(BASE_USER, BASE_BODY)).rejects.toThrow(BadRequestException);
    });
  });

  describe('3. orderDelivery.ssgEventId 재저장', () => {
    it('orderDeliveryRepository.update가 새 eventId로 호출된다', async () => {
      const { sut, orderDeliveryRepository } = buildSut();
      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);
      expect(orderDeliveryRepository.update).toHaveBeenCalledWith(100, { ssgEventId: 99 });
    });
  });

  describe('4. order.ssgEventId 재저장', () => {
    it('orderRepository.update가 첫 번째 allocation의 eventId로 호출된다', async () => {
      const { sut, orderRepository } = buildSut();
      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);
      expect(orderRepository.update).toHaveBeenCalledWith(1, { ssgEventId: 99 });
    });
  });

  describe('5. 실행 순서 — 복원이 교체보다 먼저', () => {
    it('restoreTemporaryEventBalance가 orderProductMappingRepository.update보다 먼저 호출된다', async () => {
      const callOrder: string[] = [];
      const { sut, ssgEventService } = buildSut();

      ssgEventService.restoreTemporaryEventBalance = jest.fn().mockImplementation(async () => {
        callOrder.push('restore');
      });

      const mappingUpdate = jest.fn().mockImplementation(async () => {
        callOrder.push('mappingUpdate');
        return { affected: 1 };
      });
      sut.orderProductMappingRepository = { update: mappingUpdate };

      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);

      expect(callOrder[0]).toBe('restore');
      expect(callOrder).toContain('mappingUpdate');
    });
  });

  describe('6. 동시 요청 중복 방지 — pessimistic_write 락 + 가차감 이력 체크', () => {
    it('hasOpenTempDeduction이 orderId로 호출된다', async () => {
      const { sut, hasOpenTempDeduction } = buildSut();
      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);
      expect(hasOpenTempDeduction).toHaveBeenCalledWith(1);
    });

    it('hasOpenTempDeduction이 false 반환하면 BadRequestException — 잔액 복원/차감 미실행', async () => {
      // 첫 번째 요청이 완료된 후 두 번째 요청이 락 획득: isTemporary=true 이력 없음 → false
      const { sut, restoreTemporaryEventBalance, deductEventBalanceMultiple } = buildSut();
      sut.ssgEventService.hasOpenTempDeduction = jest.fn().mockResolvedValue(false);

      await expect(sut.ssgCouponExpireChange(BASE_USER, BASE_BODY)).rejects.toThrow(BadRequestException);
      expect(restoreTemporaryEventBalance).not.toHaveBeenCalled();
      expect(deductEventBalanceMultiple).not.toHaveBeenCalled();
    });

    it('hasOpenTempDeduction이 true 반환하면 정상 처리 진행', async () => {
      const { sut, restoreTemporaryEventBalance, deductEventBalanceMultiple } = buildSut();
      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);
      expect(restoreTemporaryEventBalance).toHaveBeenCalledTimes(1);
      expect(deductEventBalanceMultiple).toHaveBeenCalledTimes(1);
    });
  });

  describe('7. 배송건별 개별 예약시각 반영 — 피드백1 회귀 수정 검증', () => {
    it('mapping마다 다른 sendRequestAt이 각 delivery의 reserveDate로 개별 전달된다', async () => {
      const { sut, allocateEventsForDeliveries } = buildSut({
        allocations: [
          { deliveryId: 100, eventId: 99, price: 10000 },
          { deliveryId: 200, eventId: 98, price: 10000 },
        ],
      });

      const mapping1 = makeMapping(1, 10000, 'RESERVE', new Date('2026-07-01T09:00:00'), [makeDelivery(100, 5)]);
      const mapping2 = makeMapping(2, 10000, 'RESERVE', new Date('2026-08-15T09:00:00'), [makeDelivery(200, 5)]);
      const order = makeOrder([mapping1, mapping2]);
      sut.orderRepository.createQueryBuilder().getOne.mockResolvedValue(order);

      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);

      const [deliveries] = allocateEventsForDeliveries.mock.calls[0];
      const d100 = deliveries.find((d: any) => d.deliveryId === 100);
      const d200 = deliveries.find((d: any) => d.deliveryId === 200);

      expect(d100.reserveDate).toEqual(new Date('2026-07-01T09:00:00'));
      expect(d200.reserveDate).toEqual(new Date('2026-08-15T09:00:00'));
      expect(d100.reserveDate).not.toEqual(d200.reserveDate);
    });

    it('allocateEventsForDeliveries가 더 이상 단일 defaultReserveDate 인자로 호출되지 않는다', async () => {
      const { sut, allocateEventsForDeliveries } = buildSut();
      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);
      const callArgs = allocateEventsForDeliveries.mock.calls[0];
      expect(callArgs.length).toBe(2);
      expect(callArgs[2]).toBeUndefined();
    });

    it('즉시발송(sendType !== RESERVE) 배송건은 reserveDate가 undefined로 전달된다', async () => {
      const { sut, allocateEventsForDeliveries } = buildSut();
      const mapping = makeMapping(1, 10000, 'IMMEDIATE', null, [makeDelivery(100, 5)]);
      const order = makeOrder([mapping]);
      sut.orderRepository.createQueryBuilder().getOne.mockResolvedValue(order);

      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);

      const [deliveries] = allocateEventsForDeliveries.mock.calls[0];
      expect(deliveries[0].reserveDate).toBeUndefined();
    });
  });

  describe('8. 락 순서 통일 — 피드백2/3 동시성/데드락 방지 검증', () => {
    it('lockEventsForCouponExpireChange가 restoreTemporaryEventBalance보다 먼저, orderId/couponExpiration으로 호출된다', async () => {
      const callOrder: string[] = [];
      const { sut, ssgEventService } = buildSut();

      ssgEventService.lockEventsForCouponExpireChange = jest.fn().mockImplementation(async () => {
        callOrder.push('lock');
      });
      ssgEventService.restoreTemporaryEventBalance = jest.fn().mockImplementation(async () => {
        callOrder.push('restore');
      });

      await sut.ssgCouponExpireChange(BASE_USER, BASE_BODY);

      expect(ssgEventService.lockEventsForCouponExpireChange).toHaveBeenCalledWith(1, 60);
      expect(callOrder).toEqual(['lock', 'restore']);
    });
  });
});
