import { BadRequestException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

/**
 * 폐기 동시성/terminal 회귀 테스트 (리뷰 반영분 검증).
 *
 * 검증 대상:
 *  (A) terminal 재진입 차단 — beforeChange 가 terminal(USED/CANCEL/REFUND_CANCEL)이면
 *      외부 cancel/Tx 이전에 거부 (HIGH-1)
 *  (B) Tx1 CAS — 조건부 UPDATE affected=0 이면 throw 하고 잔액복구(Tx2) 미호출 (LOW-②)
 *
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 private 메서드를 격리 호출하고,
 * 필요한 협력자만 mock 주입한다. (discard-restore.spec 관례)
 */
describe('CustomerServiceService.execDiscard — terminal 차단 / CAS 멱등', () => {
  const operator = { id: 9, email: 'op@enmad.com' } as any;

  // product.type=GENERAL 이라 resolveCsCouponAuthority 가 CUSTOMER_GENERAL_COUPON 반환(통과),
  // partnerCompany 없음 → getPartnerType=undefined → switch default(외부 cancel 없음)
  const buildOrderDelivery = (couponStatus: OrderDeliveryCouponStatus) =>
    ({
      id: 7001,
      couponStatus,
      orderProductMapping: { product: { type: 'GENERAL' } },
    }) as any;

  // orderDeliveryRepository.createQueryBuilder() 의 fluent 체인 mock — getOne 이 대상 반환
  const mockRepoReturning = (orderDelivery: any) => {
    const qb: any = {};
    for (const m of ['createQueryBuilder', 'innerJoinAndSelect', 'leftJoinAndSelect', 'where']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getOne = jest.fn().mockResolvedValue(orderDelivery);
    return { createQueryBuilder: jest.fn(() => qb) };
  };

  const makeSut = (orderDelivery: any) => {
    const sut: any = Object.create(CustomerServiceService.prototype);
    sut.orderDeliveryRepository = mockRepoReturning(orderDelivery);
    sut.authService = { authorityValidator: jest.fn().mockResolvedValue(undefined) };
    return sut;
  };

  describe('(A) terminal 재진입 차단', () => {
    it.each([
      OrderDeliveryCouponStatus.USED,
      OrderDeliveryCouponStatus.CANCEL,
      OrderDeliveryCouponStatus.REFUND_CANCEL,
    ])('beforeChange=%s 이면 외부 cancel/Tx 이전에 거부', async (terminal) => {
      const sut = makeSut(buildOrderDelivery(terminal));
      // 외부 cancel/Tx 가 호출되면 안 되므로, restoreBalanceOnDiscard 를 spy 로 두고 미호출 확인
      sut.restoreBalanceOnDiscard = jest.fn();

      await expect(
        sut.execDiscard(operator, 7001, OrderDeliveryCouponStatus.CANCEL),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(sut.restoreBalanceOnDiscard).not.toHaveBeenCalled();
    });

    it('beforeChange=NOT_USED 는 terminal 가드를 통과한다', async () => {
      const sut = makeSut(buildOrderDelivery(OrderDeliveryCouponStatus.NOT_USED));
      // Tx1 CAS 에서 affected=1 로 정상 진행되게 트랜잭션 mock 주입
      const txMock = makeTxRunner(1);
      sut.dataSource = { createQueryRunner: jest.fn(() => txMock) };
      sut.orderHistoryRepository = { create: jest.fn(() => ({})) };
      sut.restoreBalanceOnDiscard = jest.fn().mockResolvedValue(undefined);

      // terminal 거부 메시지로 던지지 않아야 함 (통과해서 폐기 흐름 진입)
      await expect(
        sut.execDiscard(operator, 7001, OrderDeliveryCouponStatus.CANCEL),
      ).resolves.toBeDefined();
    });
  });

  describe('(B) Tx1 CAS — affected=0 멱등 차단', () => {
    it('조건부 UPDATE affected=0 이면 throw 하고 restoreBalanceOnDiscard(Tx2) 미호출', async () => {
      const sut = makeSut(buildOrderDelivery(OrderDeliveryCouponStatus.NOT_USED));
      const txMock = makeTxRunner(0); // CAS 결과 affected=0 (경합)
      sut.dataSource = { createQueryRunner: jest.fn(() => txMock) };
      sut.orderHistoryRepository = { create: jest.fn(() => ({})) };
      sut.restoreBalanceOnDiscard = jest.fn().mockResolvedValue(undefined);

      await expect(
        sut.execDiscard(operator, 7001, OrderDeliveryCouponStatus.CANCEL),
      ).rejects.toBeInstanceOf(BadRequestException);

      // affected=0 이면 Tx1 에서 throw → Tx2 잔액복구는 실행되지 않아야 함
      expect(sut.restoreBalanceOnDiscard).not.toHaveBeenCalled();
      // 롤백이 호출됐는지 확인
      expect(txMock.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('(C) bulkDiscard — 조건부 UPDATE(CAS) 사용 검증', () => {
    // 운영자: authorityList 에 CUSTOMER_GENERAL_COUPON 부여 → 권한검사 통과
    const operatorEntity = { id: 9, personName: 'OP', authority: 'OPERATION_ADMIN', authorityList: 'CUSTOMER_GENERAL_COUPON' };

    // couponStatus=NOT_USED(폐기 가능), product.type=GENERAL(권한 통과),
    // partnerCompany 없음 → partnerCompanyName=undefined → switch default(외부 cancel 없음)
    const buildBulkOrderDelivery = () =>
      ({
        id: 8001,
        couponStatus: OrderDeliveryCouponStatus.NOT_USED,
        orderProductMapping: { product: { type: 'GENERAL', partnerCompany: undefined }, order: {} },
        choiceSelectProduct: undefined,
      }) as any;

    const makeBulkSut = (txAffected: number) => {
      const sut: any = Object.create(CustomerServiceService.prototype);
      sut.userRepository = { findOne: jest.fn().mockResolvedValue(operatorEntity) };
      sut.orderDeliveryRepository = { findOne: jest.fn().mockResolvedValue(buildBulkOrderDelivery()) };
      sut.dataSource = { createQueryRunner: jest.fn(() => makeTxRunner(txAffected)) };
      sut.orderHistoryRepository = { create: jest.fn(() => ({})) };
      sut.restoreBalanceOnDiscard = jest.fn().mockResolvedValue(undefined);
      return sut;
    };

    it('CAS affected=1 이면 성공 처리 + 잔액복구 호출', async () => {
      const sut = makeBulkSut(1);

      const result = await sut.bulkDiscard(operator, [8001], '일괄폐기');

      expect(result.success).toEqual([8001]);
      expect(result.failed).toHaveLength(0);
      expect(sut.restoreBalanceOnDiscard).toHaveBeenCalledTimes(1);
    });

    it('CAS affected=0(경합)이면 failed 로 skip + 잔액복구 미호출 (동시 REFUND_CANCEL 덮어쓰기 차단)', async () => {
      const sut = makeBulkSut(0);

      const result = await sut.bulkDiscard(operator, [8001], '일괄폐기');

      expect(result.success).toHaveLength(0);
      expect(result.failed).toEqual([{ id: 8001, reason: '동시에 상태가 변경되어 폐기하지 못했습니다.' }]);
      expect(sut.restoreBalanceOnDiscard).not.toHaveBeenCalled();
    });
  });

  // queryRunner mock — manager.createQueryBuilder().update().set().where().execute() => {affected}
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
});
