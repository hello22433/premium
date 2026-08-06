import { BadRequestException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';

/**
 * 환불폐기(REFUND_CANCEL) 원자화 회귀 테스트.
 *
 * 검증 대상:
 *  (A) REFUND_CANCEL Tx1 CAS UPDATE 에 refundStatus·refundRegisterAt·refundRatio 포함
 *  (B) refundRatio=null 일 때 상태 전이 거부 (refundRatio 없이 PROGRESS 찍히면 환불금액 0원 위험)
 *  (C) 일반 CANCEL 에는 환불 필드 변경 없음
 *
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 private 메서드를 격리 호출하고,
 * 필요한 협력자만 mock 주입한다. (discard-concurrency.spec 관례)
 */
describe('CustomerServiceService.execDiscard — REFUND_CANCEL 환불 필드 원자화', () => {
  const operator = { id: 9, email: 'op@enmad.com' } as any;

  const buildOrderDelivery = (
    couponStatus: OrderDeliveryCouponStatus,
    refundRatio: number | null = null,
  ) =>
    ({
      id: 7001,
      couponStatus,
      refundRatio,
      refundStatus: null,
      refundRegisterAt: null,
      orderProductMapping: {
        product: { type: 'GENERAL' },
        order: { cardSurchargeApplied: false },
      },
    }) as any;

  const mockRepoReturning = (orderDelivery: any) => {
    const qb: any = {};
    for (const m of [
      'createQueryBuilder',
      'innerJoinAndSelect',
      'leftJoinAndSelect',
      'where',
      'update',
      'set',
      'andWhere',
    ]) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getOne = jest.fn().mockResolvedValue(orderDelivery);
    qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
    return {
      createQueryBuilder: jest.fn(() => qb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
  };

  function makeTxRunner(affected: number) {
    const ub: any = {};
    for (const m of ['update', 'set', 'where']) ub[m] = jest.fn(() => ub);
    ub.execute = jest.fn().mockResolvedValue({ affected });
    const manager = {
      createQueryBuilder: jest.fn(() => ub),
      save: jest.fn().mockResolvedValue(undefined),
    };
    return {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager,
    } as any;
  }

  const makeSut = (orderDelivery: any) => {
    const sut: any = Object.create(CustomerServiceService.prototype);
    sut.cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    sut.orderDeliveryRepository = mockRepoReturning(orderDelivery);
    sut.authService = { authorityValidator: jest.fn().mockResolvedValue(undefined) };
    sut.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    return sut;
  };

  describe('(A) REFUND_CANCEL → Tx1 CAS payload 에 환불 필드 포함', () => {
    it('refundStatus=PROGRESS, refundRegisterAt, refundRatio 가 set payload 에 들어간다', async () => {
      const od = buildOrderDelivery(OrderDeliveryCouponStatus.NOT_USED, 80);
      const sut = makeSut(od);
      const txMock = makeTxRunner(1);
      sut.dataSource = { createQueryRunner: jest.fn(() => txMock) };
      sut.orderHistoryRepository = { create: jest.fn(() => ({})) };

      await sut.execDiscard(operator, 7001, OrderDeliveryCouponStatus.REFUND_CANCEL, undefined, {
        refundRatio: 80,
      });

      // Tx1 manager.createQueryBuilder().update().set() 의 인자 검증
      const setArg = txMock.manager.createQueryBuilder().set.mock.calls[0]?.[0];
      expect(setArg).toMatchObject({
        couponStatus: OrderDeliveryCouponStatus.REFUND_CANCEL,
        discardedAt: expect.any(Date),
        refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS,
        refundRegisterAt: expect.any(Date),
        refundRatio: 80,
      });
    });

    it('options.refundRatio 미전달 시 orderDelivery.refundRatio 를 사용한다', async () => {
      const od = buildOrderDelivery(OrderDeliveryCouponStatus.NOT_USED, 90);
      const sut = makeSut(od);
      const txMock = makeTxRunner(1);
      sut.dataSource = { createQueryRunner: jest.fn(() => txMock) };
      sut.orderHistoryRepository = { create: jest.fn(() => ({})) };

      await sut.execDiscard(operator, 7001, OrderDeliveryCouponStatus.REFUND_CANCEL);

      const setArg = txMock.manager.createQueryBuilder().set.mock.calls[0]?.[0];
      expect(setArg.refundRatio).toBe(90);
      expect(setArg.refundStatus).toBe(OrderDeliveryRefundStatusEnum.PROGRESS);
    });
  });

  describe('(B) refundRatio 없으면 전이 거부', () => {
    it('refundRatio=null 이고 options 미전달이면 BadRequestException', async () => {
      const od = buildOrderDelivery(OrderDeliveryCouponStatus.NOT_USED, null);
      const sut = makeSut(od);
      sut.dataSource = { createQueryRunner: jest.fn() };

      await expect(
        sut.execDiscard(operator, 7001, OrderDeliveryCouponStatus.REFUND_CANCEL),
      ).rejects.toThrow(BadRequestException);
      await expect(
        sut.execDiscard(operator, 7001, OrderDeliveryCouponStatus.REFUND_CANCEL),
      ).rejects.toThrow(/환불율/);
    });

    it('refundRatio=0 이면 BadRequestException', async () => {
      const od = buildOrderDelivery(OrderDeliveryCouponStatus.NOT_USED, null);
      const sut = makeSut(od);
      sut.dataSource = { createQueryRunner: jest.fn() };

      await expect(
        sut.execDiscard(operator, 7001, OrderDeliveryCouponStatus.REFUND_CANCEL, undefined, {
          refundRatio: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refundRatio=101 이면 BadRequestException', async () => {
      const od = buildOrderDelivery(OrderDeliveryCouponStatus.NOT_USED, null);
      const sut = makeSut(od);
      sut.dataSource = { createQueryRunner: jest.fn() };

      await expect(
        sut.execDiscard(operator, 7001, OrderDeliveryCouponStatus.REFUND_CANCEL, undefined, {
          refundRatio: 101,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('(C) 일반 CANCEL 에는 환불 필드 미포함', () => {
    it('set payload 에 refundStatus/refundRegisterAt/refundRatio 가 없다', async () => {
      const od = buildOrderDelivery(OrderDeliveryCouponStatus.NOT_USED, 80);
      const sut = makeSut(od);
      const txMock = makeTxRunner(1);
      sut.dataSource = { createQueryRunner: jest.fn(() => txMock) };
      sut.orderHistoryRepository = { create: jest.fn(() => ({})) };
      sut.restoreBalanceOnDiscard = jest.fn().mockResolvedValue(undefined);

      await sut.execDiscard(operator, 7001, OrderDeliveryCouponStatus.CANCEL);

      const setArg = txMock.manager.createQueryBuilder().set.mock.calls[0]?.[0];
      expect(setArg).toMatchObject({
        couponStatus: OrderDeliveryCouponStatus.CANCEL,
        discardedAt: expect.any(Date),
      });
      expect(setArg).not.toHaveProperty('refundStatus');
      expect(setArg).not.toHaveProperty('refundRegisterAt');
      expect(setArg).not.toHaveProperty('refundRatio');
    });
  });
});
