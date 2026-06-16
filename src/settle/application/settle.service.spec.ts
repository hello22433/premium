import { SettleService } from './settle.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { applyCardSurcharge } from '../../order/domain/order.fee.calculator';
import { SettleUserOrderDetailEnum } from '../interface/settle.user.order.detail';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { addTransactionalDataSource, deleteDataSourceByName, initializeTransactionalContext } from 'typeorm-transactional';

beforeAll(() => {
  initializeTransactionalContext();
  addTransactionalDataSource({
    name: 'default',
    dataSource: {
      transaction: async (...args: any[]) => {
        const callback = args[args.length - 1];
        return callback({});
      },
    } as any,
    patch: false,
  });
});

afterAll(() => {
  deleteDataSourceByName('default');
});

const createService = (overrides: Record<string, any> = {}) => {
  const deps: any = {
    orderRepository: {},
    orderDeliveryRepository: {},
    otherSaleRepository: {},
    otherSaleProductMappingRepository: {},
    otherSaleProductRepository: {},
    shippingStorageRepository: {},
    userDiscountRepository: {},
    saleTypeRepository: {},
    userRepository: {},
    galaxiaBarcodeLogRepository: {},
    activityLogRepository: {},
    orderDeliveryRefundRepository: {},
    activityLogService: {},
    cryptoCipher: {},
    walletManagedPredicate: {},
    settleConfirmationWalletService: {},
    walletAccountResolverService: {},
    walletCutoverConfig: {},
    ...overrides,
  };

  return new SettleService(
    deps.orderRepository,
    deps.orderDeliveryRepository,
    deps.otherSaleRepository,
    deps.otherSaleProductMappingRepository,
    deps.otherSaleProductRepository,
    deps.shippingStorageRepository,
    deps.userDiscountRepository,
    deps.saleTypeRepository,
    deps.userRepository,
    deps.galaxiaBarcodeLogRepository,
    deps.activityLogRepository,
    deps.orderDeliveryRefundRepository,
    deps.activityLogService,
    deps.cryptoCipher,
    deps.walletManagedPredicate,
    deps.settleConfirmationWalletService,
    deps.walletAccountResolverService,
    deps.walletCutoverConfig,
  ) as any;
};

describe('SettleService settlement amount integrity', () => {
  it('정산확정 summary는 카드할증을 배송별이 아니라 주문 단위로 1회 적용한다', async () => {
    const order = { id: 10, cardSurchargeApplied: true };
    const mapping = {
      amount: 2,
      fee: null,
      priceAdjustment: null,
      snapshotProductPrice: 9999,
      product: { price: 9999 },
      order,
    };
    const deliveries = [
      {
        status: IOrderDeliveryStatus.COMPLETE,
        couponStatus: null,
        settleFee: null,
        settlePriceAdjustment: null,
        orderProductMapping: mapping,
      },
      {
        status: IOrderDeliveryStatus.COMPLETE_SMS,
        couponStatus: OrderDeliveryCouponStatus.REFUND_CANCEL,
        settleFee: null,
        settlePriceAdjustment: null,
        orderProductMapping: mapping,
      },
    ];
    const service = createService({
      orderDeliveryRepository: {
        find: jest.fn().mockResolvedValue(deliveries),
      },
    }) as any;

    const summary = await service.getOrderSettlementSummary([order.id]);

    expect(summary.get(order.id)).toEqual({
      hasPending: false,
      netAmount: applyCardSurcharge(9999 + 9999, true),
    });
  });

  it('정산해제는 정산확정 후 폐기 복구된 금액을 snapshot에서 차감한 금액만 미정산 장부에 복원한다', async () => {
    const order = {
      id: 20,
      userId: 30,
      clientUserId: null,
      isSettleBalance: false,
      settleStatus: SettleUserOrderDetailEnum.SETTLE_COMPLETE,
      settledAmountSnapshot: 10000,
    };
    const updateExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const updateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      execute: updateExecute,
    };
    const orderQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const orderRepository = {
      manager: {},
      createQueryBuilder: jest.fn().mockReturnValueOnce(orderQb).mockReturnValueOnce(orderQb),
    };
    const userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 30, settleCondition: IUserSettleCondition.PRE_PAYMENT }),
      createQueryBuilder: jest.fn().mockReturnValue(updateQb),
    };
    const refundQb = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ totalRestore: '3000' }),
    };
    const service = createService({
      orderRepository,
      userRepository,
      orderDeliveryRefundRepository: {
        createQueryBuilder: jest.fn().mockReturnValue(refundQb),
      },
      walletManagedPredicate: {
        isWalletManaged: jest.fn().mockResolvedValue(false),
      },
    }) as any;

    await service.updateUserPerOrder({
      orderId: order.id,
      settleStatus: SettleUserOrderDetailEnum.UNSETTLE_NORMAL,
    });

    expect(updateQb.setParameters).toHaveBeenCalledWith({ amount: 7000 });
  });
});
