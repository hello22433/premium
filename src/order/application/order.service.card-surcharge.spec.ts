import { OrderService } from './order.service';
import { applyCardSurcharge } from '../domain/order.fee.calculator';
import { IOrderStatus } from '../interface/order.status';
import { addTransactionalDataSource, deleteDataSourceByName, initializeTransactionalContext } from 'typeorm-transactional';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IOrderType } from '../interface/order.type';
import { WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';

describe('OrderService card surcharge settlement priority', () => {
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

  afterAll(() => {
    deleteDataSourceByName('default');
  });

  const createService = ({
    settleMethod,
    orderOverrides = {},
    settleFee = 500,
    extraOrderProducts = [],
    existingOrderProductOverrides = {},
  }: {
    settleMethod: string | null;
    orderOverrides?: Record<string, unknown>;
    settleFee?: number;
    extraOrderProducts?: Record<string, unknown>[];
    existingOrderProductOverrides?: Record<string, unknown>;
  }) => {
    const order = {
      id: 77,
      userId: 1,
      clientUserId: 2,
      sendAmount: 10000,
      settleAmount: 10000,
      cardSurchargeApplied: undefined,
      isNewBillingFlow: true,
      isSettleBalance: true,
      status: IOrderStatus.REVIEW_COMPLETE,
      ...orderOverrides,
    };

    const existingOrderProduct = {
      id: 10,
      orderId: order.id,
      order,
      amount: 1,
      fee: null,
      priceAdjustment: null,
      product: {
        price: order.sendAmount + settleFee,
      },
      orderDeliveries: [],
      ...existingOrderProductOverrides,
    };

    const queryBuilder = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn()
        .mockResolvedValueOnce([existingOrderProduct])
        .mockResolvedValue([existingOrderProduct, ...extraOrderProducts]),
    };

    const service = Object.create(OrderService.prototype) as any;
    service.orderProductMappingRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      save: jest.fn(),
    };
    service.orderRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({
        company: {
          settleMethod,
        },
      }),
      findOneOrFail: jest.fn(),
      save: jest.fn(),
    };
    service.userCompanyRepository = {
      save: jest.fn(),
    };
    service.processSettleList = jest.fn().mockResolvedValue({
      orderProductList: [],
    });

    return {
      service,
      order,
      settleFee,
    };
  };

  const createBody = (overrides: Record<string, unknown> = {}) =>
    ({
      list: [{ id: 10 }],
      ...overrides,
    }) as any;

  it('createOrderSettle: body 값이 있으면 settleMethod보다 body 값을 우선한다', async () => {
    const { service, order, settleFee } = createService({ settleMethod: 'CARD' });

    await service.createOrderSettle(createBody({ cardSurchargeApplied: false }));

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, false),
        cardSurchargeApplied: false,
      },
    );
  });

  it('createOrderSettle: body 값이 없고 settleMethod가 CARD이면 카드할증을 적용한다', async () => {
    const { service, order, settleFee } = createService({ settleMethod: 'CARD' });

    await service.createOrderSettle(createBody());

    expect(service.userRepository.findOne).toHaveBeenCalledWith({
      where: { id: order.clientUserId },
      relations: ['company'],
    });
    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, true),
        cardSurchargeApplied: true,
      },
    );
  });

  it('createOrderSettle: 요청 목록이 일부여도 주문 전체 상품 기준으로 정산금액을 계산한다', async () => {
    const { service, order, settleFee } = createService({
      settleMethod: 'CASH',
      extraOrderProducts: [
        {
          id: 11,
          orderId: 77,
          order: {},
          amount: 1,
          fee: null,
          priceAdjustment: null,
          product: {
            price: 3000,
          },
          orderDeliveries: [],
        },
      ],
    });

    await service.createOrderSettle(createBody());

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee + 3000, false),
        cardSurchargeApplied: false,
      },
    );
  });

  it('createOrderSettle: 단가별 반올림이 필요한 금액도 주문 정산 helper 기준으로 계산한다', async () => {
    // price=3333, fee=10%, amount=3: per-unit=9000, aggregate=8999 (반올림 기준이 달라지는 케이스)
    const { service, order } = createService({
      settleMethod: 'CASH',
      orderOverrides: {
        sendAmount: 9999,
      },
      existingOrderProductOverrides: {
        amount: 3,
        fee: 10,
        priceAdjustment: IPriceAdjustment.DISCOUNT,
        product: {
          price: 3333,
        },
      },
    });

    await service.createOrderSettle(createBody());

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(9000, false),
        cardSurchargeApplied: false,
      },
    );
  });

  it('createOrderSettle: body 값이 없고 settleMethod가 CARD가 아니면 카드할증을 적용하지 않는다', async () => {
    const { service, order, settleFee } = createService({ settleMethod: 'CASH' });

    await service.createOrderSettle(createBody());

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, false),
        cardSurchargeApplied: false,
      },
    );
  });

  it('updateOrderSettle: body 값이 있으면 기존 저장값과 settleMethod보다 body 값을 우선한다', async () => {
    const { service, order, settleFee } = createService({
      settleMethod: 'CASH',
      orderOverrides: {
        cardSurchargeApplied: false,
      },
    });

    await service.updateOrderSettle(createBody({ cardSurchargeApplied: true }));

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, true),
        cardSurchargeApplied: true,
      },
    );
  });

  it('updateOrderSettle: body false면 기존 저장값이 true여도 false로 덮어쓴다', async () => {
    const { service, order, settleFee } = createService({
      settleMethod: 'CARD',
      orderOverrides: {
        cardSurchargeApplied: true,
      },
    });

    await service.updateOrderSettle(createBody({ cardSurchargeApplied: false }));

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, false),
        cardSurchargeApplied: false,
      },
    );
  });

  it('updateOrderSettle: body 값이 없으면 기존 저장값을 settleMethod보다 우선한다', async () => {
    const { service, order, settleFee } = createService({
      settleMethod: 'CARD',
      orderOverrides: {
        cardSurchargeApplied: false,
      },
    });

    await service.updateOrderSettle(createBody());

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, false),
        cardSurchargeApplied: false,
      },
    );
  });

  it('updateOrderSettle: body 값과 기존 저장값이 모두 없으면 settleMethod 기본값을 사용한다', async () => {
    const { service, order, settleFee } = createService({
      settleMethod: 'CARD',
      orderOverrides: {
        cardSurchargeApplied: undefined,
      },
    });

    await service.updateOrderSettle(createBody());

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee, true),
        cardSurchargeApplied: true,
      },
    );
  });

  it('updateOrderSettle: 요청 목록이 일부여도 주문 전체 상품 기준으로 정산금액을 계산한다', async () => {
    const { service, order, settleFee } = createService({
      settleMethod: 'CASH',
      orderOverrides: {
        cardSurchargeApplied: false,
      },
      extraOrderProducts: [
        {
          id: 11,
          orderId: 77,
          order: {},
          amount: 1,
          fee: null,
          priceAdjustment: null,
          product: {
            price: 3000,
          },
          orderDeliveries: [],
        },
      ],
    });

    await service.updateOrderSettle(createBody());

    expect(service.orderRepository.update).toHaveBeenCalledWith(
      { id: order.id },
      {
        settleAmount: applyCardSurcharge(order.sendAmount + settleFee + 3000, false),
        cardSurchargeApplied: false,
      },
    );
  });
});

describe('OrderService SSG settlement row validation', () => {
  const createService = () => {
    const service = Object.create(OrderService.prototype) as any;
    service.orderDeliveryRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service.orderProductMappingRepository = {
      create: jest.fn((value) => value),
    };
    return service;
  };

  const createOrderProductMap = () => {
    const deliveries = [
      { id: 1, settleFee: null, settlePriceAdjustment: null, settleDiscountType: null },
      { id: 2, settleFee: null, settlePriceAdjustment: null, settleDiscountType: null },
    ];
    return {
      deliveries,
      map: new Map([
        [
          10,
          {
            id: 10,
            amount: 2,
            fee: null,
            priceAdjustment: null,
            settleDiscountType: null,
            product: { price: 10000 },
            orderDeliveries: deliveries,
          },
        ],
      ]),
    };
  };

  it('같은 mapping 안에서 배송별 정산율이 달라도 delivery 단위로 저장한다', async () => {
    const service = createService();
    const { deliveries, map } = createOrderProductMap();

    const result = await service.processSettleList(
      [
        { id: 10, deliveryIds: [1], fee: 5, priceAdjustment: IPriceAdjustment.DISCOUNT },
        { id: 10, deliveryIds: [2], fee: 10, priceAdjustment: IPriceAdjustment.DISCOUNT },
      ],
      map,
    );

    expect(result.orderProductList).toEqual([]);
    expect(deliveries).toEqual([
      { id: 1, settleFee: 5, settlePriceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: undefined },
      { id: 2, settleFee: 10, settlePriceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: undefined },
    ]);
  });

  it('SSG 가상 row가 mapping 일부 배송만 포함해도 해당 배송만 저장한다', async () => {
    const service = createService();
    const { deliveries, map } = createOrderProductMap();

    const result = await service.processSettleList(
      [{ id: 10, deliveryIds: [1], fee: 5, priceAdjustment: IPriceAdjustment.DISCOUNT }],
      map,
    );

    expect(result.orderProductList).toEqual([]);
    expect(service.orderDeliveryRepository.update).toHaveBeenCalledWith(
      { id: expect.anything() },
      {
        settleFee: 5,
        settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
        settleDiscountType: undefined,
      },
    );
    expect(deliveries[0]).toMatchObject({ settleFee: 5, settlePriceAdjustment: IPriceAdjustment.DISCOUNT });
    expect(deliveries[1]).toMatchObject({ settleFee: null, settlePriceAdjustment: null });
  });

  it('다른 mapping의 deliveryId가 섞인 cross row 저장을 거부한다', async () => {
    const service = createService();
    const { map } = createOrderProductMap();
    map.set(11, {
      id: 11,
      amount: 1,
      fee: null,
      priceAdjustment: null,
      settleDiscountType: null,
      product: { price: 20000 },
      orderDeliveries: [{ id: 99, settleFee: null, settlePriceAdjustment: null, settleDiscountType: null }],
    });

    await expect(
      service.processSettleList(
        [{ id: 10, deliveryIds: [1, 99], fee: 5, priceAdjustment: IPriceAdjustment.DISCOUNT }],
        map,
      ),
    ).rejects.toThrow('여러 상품이 묶인 정산 항목은 상품별로 분리해서 저장해주세요.');
  });

  it('정상 SSG 가상 row는 mapping 전체 배송과 mapping 대표값을 같은 정산값으로 동기화한다', async () => {
    const service = createService();
    const { deliveries, map } = createOrderProductMap();

    const result = await service.processSettleList(
      [
        { id: 10, deliveryIds: [1], fee: 5, priceAdjustment: IPriceAdjustment.DISCOUNT, refund: 100 },
        { id: 10, deliveryIds: [2], fee: 5, priceAdjustment: IPriceAdjustment.DISCOUNT, refund: 100 },
      ],
      map,
    );

    expect(result.orderProductList).toEqual([
      {
        id: 10,
        settleDiscountType: undefined,
        priceAdjustment: IPriceAdjustment.DISCOUNT,
        fee: 5,
      },
    ]);
    expect(service.orderDeliveryRepository.update).toHaveBeenCalledWith(
      { id: expect.anything() },
      {
        settleFee: 5,
        settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
        settleDiscountType: undefined,
      },
    );
    expect(service.orderDeliveryRepository.update).toHaveBeenCalledWith(
      { id: expect.anything() },
      { refundRatio: 100 },
    );
    expect(deliveries).toEqual([
      { id: 1, settleFee: 5, settlePriceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: undefined, refundRatio: 100 },
      { id: 2, settleFee: 5, settlePriceAdjustment: IPriceAdjustment.DISCOUNT, settleDiscountType: undefined, refundRatio: 100 },
    ]);
  });
});

describe('OrderService deliveryConfirmed settlement amount', () => {
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

  afterAll(() => {
    deleteDataSourceByName('default');
  });

  const createQueryBuilder = (result: unknown) => ({
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
    getOneOrFail: jest.fn().mockResolvedValue(result),
  });

  it('deliveryConfirmed: 발송확정 금액은 mapping 수수료가 아니라 배송별 정산값 합산 기준으로 차감한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    const deliveries = [
      {
        id: 1,
        deliveryTarget: '01011112222',
        settleFee: 5,
        settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
      },
      {
        id: 2,
        deliveryTarget: '01033334444',
        settleFee: 10,
        settlePriceAdjustment: IPriceAdjustment.DISCOUNT,
      },
    ];
    const order = {
      id: 77,
      userId: 1,
      clientUserId: 2,
      operationUserId: 1,
      eventName: 'event',
      type: IOrderType.GENERAL,
      status: IOrderStatus.REVIEW_COMPLETE,
      sendAmount: 19998,
      cardSurchargeApplied: false,
      isNewBillingFlow: true,
      orderProductMappings: [
        {
          id: 10,
          productId: 100,
          amount: 2,
          fee: 5,
          priceAdjustment: IPriceAdjustment.DISCOUNT,
          sendTitle: 'title',
          sendContent: 'content',
          product: {
            price: 9999,
            useStatus: 'USE',
            partnerCompanyId: 20,
            partnerCompany: {},
            brand: {},
          },
          orderDeliveries: deliveries,
        },
      ],
    } as any;
    const billingUser = {
      id: 2,
      balance: 50000,
      allSettleAmount: 0,
      duplicatePhoneLimit: 0,
      companyId: null,
    };

    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(createQueryBuilder(order)),
      save: jest.fn().mockResolvedValue(order),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 1,
        authority: 'OPERATION_ADMIN',
        status: 'USED',
        authorityList: null,
      }),
      createQueryBuilder: jest.fn().mockReturnValue(createQueryBuilder(billingUser)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service.userCompanyRepository = {
      update: jest.fn(),
    };
    service.userDiscountRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    service.orderProductMappingRepository = {
      save: jest.fn(),
    };
    service.orderDeliveryRepository = {
      save: jest.fn().mockResolvedValue(undefined),
    };
    service.logger = {
      debug: jest.fn(),
      warn: jest.fn(),
    };
    service.cryptoCipher = { safeDecryptDeliveryTarget: (v: string) => v };
    service.ssgEventService = { confirmEventBalance: jest.fn() };
    // Wallet Cutover Bundle (PR2-005) — LEGACY mode 로 기존 path 유지
    service.walletCutoverConfig = {
      get pr2DeliveryLifecycleMode() {
        return WalletCutoverMode.LEGACY;
      },
    };
    service.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(false) };
    service.walletAccountResolverService = { resolveForOrder: jest.fn() };
    service.paymentAllocationService = { allocate: jest.fn() };
    service.orderConfirmationWalletService = { persistAllocation: jest.fn() };
    service.orderConfirmationReleaseService = { releaseConfirmation: jest.fn() };
    service.shadowMismatchClassifierService = { classify: jest.fn() };

    await service.deliveryConfirmed({ id: 1 } as any, { id: order.id } as any);

    const orderQueryBuilder = service.orderRepository.createQueryBuilder.mock.results[0].value;
    expect(orderQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(order.settleAmount).toBe(18498);
    expect(service.userRepository.update).toHaveBeenCalledWith(
      { id: billingUser.id },
      { balance: 50000 - 18498, allSettleAmount: 0 },
    );
    expect(order.settleAmount).not.toBe(18999);
  });
});
