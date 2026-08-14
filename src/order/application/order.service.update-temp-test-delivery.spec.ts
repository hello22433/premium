import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IUserAuthority } from '../../user/interface/user.authority';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

describe('OrderService updateTemp 테스트 발송 이력·한도 승계', () => {
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

  const user = { id: 10, email: 'owner@example.com', authority: IUserAuthority.CORPORATE_ADMIN };
  const ORDER_ID = 77;

  /** 기존 매핑. updateTemp 는 이 행을 지우고 새 id 로 재생성한다. */
  const existingMapping = (id: number, productId: number, testDeliveryCount: number) => ({
    id,
    orderId: ORDER_ID,
    productId,
    testDeliveryCount,
    snapshotProductPrice: 1000,
    snapshotProductName: 'product',
    snapshotProductBrandName: 'brand',
    snapshotProductExpireDay: 30,
    snapshotProductImagePath: null,
    snapshotProductCategory: null,
    snapshotProductClassificationId: null,
    partnerSettleFee: null,
    partnerSettlePriceAdjustment: null,
  });

  const line = (id: number | undefined, productId: number) => ({
    id,
    productId,
    amount: 1,
    sendType: 'IMMEDIATE',
    sendMethod: 'MMS',
    orderDeliveryList: [{ deliveryTarget: '01012345678' }],
  });

  const buildService = (mappings: any[], productIds: number[] = [1]) => {
    const service = Object.create(OrderService.prototype) as any;

    let nextMappingId = 900;
    service.savedMappings = [];
    service.historyMoves = [];

    service.assertPositiveIntegerAmounts = jest.fn();
    service.assertNoForbiddenWord = jest.fn();
    service.buildManualEntries = jest.fn(() => []);
    service.resolveOrderExpireAt = jest.fn(() => null);
    // 암호화 시점을 기록한다. 매핑 잠금 전에 끝나야 매핑 X락 구간이 짧아진다.
    service.encryptedBeforeLock = true;
    service.cryptoCipher = {
      encryptDeliveryTarget: jest.fn((target: string) => {
        if (service.lockedMappingQuery) service.encryptedBeforeLock = false;
        return target;
      }),
    };

    service.lockedOrderQuery = false;
    // 락을 잡은 순서. 데드락 방지를 위해 order -> orderProductMapping 이어야 한다.
    service.lockOrder = [];
    service.orderRepository = {
      // updateTemp 는 주문 행을 먼저 잠근다(락 순서 통일). 잠금 여부를 기록해 검증한다.
      createQueryBuilder: jest.fn(() => {
        const builder: any = {
          setLock: jest.fn((mode: string) => {
            service.lockedOrderQuery = mode === 'pessimistic_write';
            service.lockOrder.push('order');
            return builder;
          }),
          where: jest.fn(() => builder),
          getOne: jest.fn(() => Promise.resolve({ id: ORDER_ID, userId: user.id, status: IOrderStatus.TEMP })),
        };
        return builder;
      }),
      save: jest.fn(),
    };
    service.userRepository = {
      findOne: jest.fn(() => Promise.resolve({ id: user.id, allowedSendMethods: null })),
    };
    service.productRepository = {
      find: jest.fn(() =>
        Promise.resolve(productIds.map((id) => ({ id, price: 1000, expireDay: 30, galaxiaDuration: null }))),
      ),
    };
    service.lockedMappingQuery = false;
    service.orderProductMappingRepository = {
      createQueryBuilder: jest.fn(() => {
        const builder: any = {
          setLock: jest.fn((mode: string) => {
            service.lockedMappingQuery = mode === 'pessimistic_write';
            service.lockOrder.push('orderProductMapping');
            return builder;
          }),
          where: jest.fn(() => builder),
          getMany: jest.fn(() => Promise.resolve(mappings)),
        };
        return builder;
      }),
      delete: jest.fn(),
      save: jest.fn((entity: any) => {
        entity.id = nextMappingId++;
        service.savedMappings.push(entity);
        return Promise.resolve(entity);
      }),
    };
    service.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    service.orderDeliveryRepository = { delete: jest.fn(), insert: jest.fn() };
    service.orderManualEntryRepository = { delete: jest.fn(), insert: jest.fn() };
    service.testOrderDeliveryRepository = {
      update: jest.fn((where: any, set: any) => {
        service.historyMoves.push({ from: where.orderProductMappingId, to: set.orderProductMappingId });
        return Promise.resolve({ affected: 1 });
      }),
      softDelete: jest.fn(() => Promise.resolve({ affected: 1 })),
      // 고아화 직전 WAIT 경보 마킹. 대상 라인 id 를 기록해 검증한다.
      createQueryBuilder: jest.fn(() => {
        const builder: any = {
          update: jest.fn(() => builder),
          set: jest.fn(() => builder),
          where: jest.fn((_clause: string, params?: any) => {
            if (params?.orphanedLineIds) service.escalatedLineIds = params.orphanedLineIds;
            return builder;
          }),
          andWhere: jest.fn(() => builder),
          execute: jest.fn(() => Promise.resolve({ affected: service.escalatedAffected ?? 0 })),
        };
        return builder;
      }),
    };

    return service;
  };

  const body = (orderProductList: any[]) => ({
    id: ORDER_ID,
    eventName: 'event',
    topImagePath: null,
    midImagePath: null,
    orderProductList,
  });

  it('승계 라인의 이력을 신규 매핑 id 로 옮긴다', async () => {
    const service = buildService([existingMapping(5, 1, 0)]);

    await service.updateTemp(user, body([line(5, 1)]));

    expect(service.historyMoves).toEqual([{ from: 5, to: service.savedMappings[0].id }]);
  });

  it('소진한 발송 횟수를 승계한다 (저장으로 한도가 풀리지 않는다)', async () => {
    const service = buildService([existingMapping(5, 1, 2)]);

    await service.updateTemp(user, body([line(5, 1)]));

    expect(service.savedMappings[0].testDeliveryCount).toBe(2);
  });

  it('신규 추가 라인은 승계 대상이 없어 횟수가 0 이고 이력을 옮기지 않는다', async () => {
    const service = buildService([existingMapping(5, 1, 2)], [1, 2]);

    await service.updateTemp(user, body([line(5, 1), line(undefined, 2)]));

    expect(service.savedMappings[1].testDeliveryCount).toBe(0);
    expect(service.historyMoves).toEqual([{ from: 5, to: service.savedMappings[0].id }]);
  });

  it('상품이 여러 개여도 라인별 이력이 서로 섞이지 않는다', async () => {
    const service = buildService([existingMapping(5, 1, 1), existingMapping(6, 2, 2)], [1, 2]);

    await service.updateTemp(user, body([line(5, 1), line(6, 2)]));

    expect(service.historyMoves).toEqual([
      { from: 5, to: service.savedMappings[0].id },
      { from: 6, to: service.savedMappings[1].id },
    ]);
    expect(service.savedMappings[0].testDeliveryCount).toBe(1);
    expect(service.savedMappings[1].testDeliveryCount).toBe(2);
  });

  it('상품이 교체된 라인은 이력·횟수를 승계하지 않는다', async () => {
    const service = buildService([existingMapping(5, 1, 2)], [2]);

    // 라인 id 는 그대로 두고 상품만 1 → 2 로 교체
    await service.updateTemp(user, body([line(5, 2)]));

    expect(service.savedMappings[0].testDeliveryCount).toBe(0);
    expect(service.historyMoves).toEqual([]);
  });

  it('상품이 교체된 라인의 이전 이력은 정리한다', async () => {
    const service = buildService([existingMapping(5, 1, 2)], [2]);

    await service.updateTemp(user, body([line(5, 2)]));

    expect(service.testOrderDeliveryRepository.softDelete.mock.calls[0][0].orderProductMappingId.value).toEqual([5]);
  });

  it('삭제된 라인의 이력은 승계처가 없어 정리한다', async () => {
    const service = buildService([existingMapping(5, 1, 1), existingMapping(6, 2, 2)]);

    await service.updateTemp(user, body([line(5, 1)]));

    expect(service.testOrderDeliveryRepository.softDelete).toHaveBeenCalledTimes(1);
    // 남은 라인(5)은 건드리지 않고 삭제된 라인(6)만 정리 대상이어야 한다
    expect(service.testOrderDeliveryRepository.softDelete.mock.calls[0][0].orderProductMappingId.value).toEqual([6]);
  });

  // 매핑이 삭제되면 잔류 정리(discardStaleTestDeliveries)가 그 이력에 도달할 수 없다.
  // 아직 매핑 id 로 특정 가능한 시점에 경보를 남겨야 운영이 인지할 수 있다.
  it('고아가 되는 라인의 WAIT 이력에 경보를 남긴다', async () => {
    const service = buildService([existingMapping(5, 1, 1), existingMapping(6, 2, 2)]);

    await service.updateTemp(user, body([line(5, 1)]));

    expect(service.escalatedLineIds).toEqual([6]);
  });

  it('삭제된 라인이 없으면 정리하지 않는다', async () => {
    const service = buildService([existingMapping(5, 1, 1)]);

    await service.updateTemp(user, body([line(5, 1)]));

    expect(service.testOrderDeliveryRepository.softDelete).not.toHaveBeenCalled();
  });

  it('기존 매핑을 행 잠금으로 읽는다 (동시 테스트 발송의 한도 증가분 유실 방지)', async () => {
    const service = buildService([existingMapping(5, 1, 1)]);

    await service.updateTemp(user, body([line(5, 1)]));

    expect(service.lockedMappingQuery).toBe(true);
  });

  // 수신처 암호화는 수천 건이 될 수 있어 매핑 X락 구간에서 돌리면 그만큼 테스트 발송이 대기한다.
  it('수신처 암호화를 매핑 잠금 전에 끝낸다 (락 구간 단축)', async () => {
    const service = buildService([existingMapping(5, 1, 1)]);

    await service.updateTemp(user, body([line(5, 1)]));

    expect(service.cryptoCipher.encryptDeliveryTarget).toHaveBeenCalled();
    expect(service.encryptedBeforeLock).toBe(true);
  });

  // 락 순서는 order -> order_product_mapping -> test_order_delivery 한 방향이어야 한다.
  // 주문을 먼저 잠그는 경로(deliveryRequest / deliveryConfirmed)와 순서가 반대면 데드락 사이클이 생긴다.
  it('주문 행을 매핑보다 먼저 잠근다 (락 순서 통일 — 데드락 방지)', async () => {
    const service = buildService([existingMapping(5, 1, 1)]);

    await service.updateTemp(user, body([line(5, 1)]));

    expect(service.lockedOrderQuery).toBe(true);
    expect(service.lockOrder).toEqual(['order', 'orderProductMapping']);
  });
});
