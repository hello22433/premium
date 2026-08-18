import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { UserEntity } from '../../entity/user.entity';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { OrderService } from './order.service';

/**
 * 회귀 방지: 주문에 포함된 상품이 이후 삭제(product 조인 결과 null)되어도 주문 취소는 허용되어야 한다.
 * 과거에는 totalPrice 계산에서 '상품 정보가 존재하지 않습니다.' 400을 던져 취소가 막혔다.
 * 이제 환불 단가는 주문 시점 스냅샷(snapshotProductPrice)을 사용한다.
 */
// 레거시 미러는 DB 증감식 UPDATE 다(197-16 리뷰 P1). 이 스펙의 관심사가 아니라 체인만 이어 준다
// — 증감식 형태 검증은 cancel-multiline-baseline.spec 소관.
/** 이 스펙이 관찰한 미러 증감 UPDATE. 각 setup 시작에서 비운다. */
const mirrorUpdates: Array<{ column: string; sql: string; params: any; where: any }> = [];
const mirrorBuilder = () => {
  const captured: any = {};
  const mb: any = {
    update: () => mb,
    set: (v: Record<string, () => string>) => {
      const [column, expr] = Object.entries(v)[0];
      captured.column = column;
      captured.sql = typeof expr === 'function' ? (expr as () => string)() : String(expr);
      return mb;
    },
    where: (_c: string, p: unknown) => {
      captured.where = p;
      return mb;
    },
    setParameters: (p: unknown) => {
      captured.params = p;
      return mb;
    },
    execute: async () => {
      mirrorUpdates.push(captured);
      return { affected: 1 };
    },
  };
  return mb;
};

describe('OrderService.deliveryCancel — 삭제된 상품 포함 주문', () => {
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

  const buildSut = (order: any, oneUser: any) => {
    mirrorUpdates.length = 0;
    const orderRepository = {
      manager: {},
      createQueryBuilder: jest.fn(() => {
        const builder: any = {
          setLock: () => builder,
          leftJoinAndSelect: () => builder,
          where: () => builder,
          getOne: jest.fn().mockResolvedValue(order),
        };
        return builder;
      }),
      save: jest.fn().mockResolvedValue(order),
    };
    const userRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(oneUser),
      save: jest.fn().mockResolvedValue(oneUser),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(mirrorBuilder),
    };
    const orderDeliveryRepository: any = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: () => {
        // select/getRawMany 는 findMappingIdsWithActiveDeliveries(취소된 상품행을 컷오프에서 제외) 용.
        // 이 스펙들은 취소된 행이 없는 상황이라 상품행 전부를 살아 있는 것으로 돌려준다.
        const b: any = {
          innerJoin: () => b,
          select: () => b,
          // 전체취소의 발송건 CANCEL 은 조건부 UPDATE(CAS)다 — 조건 검증은 다른 스펙 소관.
          update: () => b,
          set: () => b,
          execute: async () => ({ affected: 3 }),
          where: () => b,
          andWhere: () => b,
          // CAS 뒤 취소 안 된 발송건이 남았나 사후검사 — 남는 것이 없는 상황이다.
          getCount: async () => 0,
          getRawMany: async () => (order.orderProductMappings ?? []).map((m: any) => ({ mappingId: m.id })),
        };
        return b;
      },
    };
    const userCompanyRepository = { save: jest.fn(), createQueryBuilder: jest.fn(mirrorBuilder) };

    const sut: any = Object.create(OrderService.prototype);
    // 소유권(조회범위) 검증은 order.service.cancel-ownership.spec 에서 다룬다 — 여기선 통과시킨다.
    sut.assertOrderInViewScope = jest.fn().mockResolvedValue(undefined);
    sut.orderRepository = orderRepository;
    sut.userRepository = userRepository;
    sut.orderDeliveryRepository = orderDeliveryRepository;
    sut.userCompanyRepository = userCompanyRepository;
    sut.ssgEventService = { restoreEventBalance: jest.fn() };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(false) };
    // isSettleBalance=false 인 레거시 경로는 여신 복구를 legacyWalletCreditSyncService 로 동기화한다.
    sut.legacyWalletCreditSyncService = {
      syncCredit: jest.fn().mockResolvedValue(undefined),
      syncDeposit: jest.fn().mockResolvedValue(undefined),
    };
    return { sut, orderRepository, userRepository };
  };

  it('삭제된 상품(product=null)이어도 취소가 되고, 스냅샷 단가로 환불한다', async () => {
    const order = {
      id: 548,
      userId: 5,
      clientUserId: null,
      type: IOrderType.GENERAL,
      status: IOrderStatus.DELIVERY_REQUEST,
      isNewBillingFlow: false,
      isSettleBalance: false,
      orderProductMappings: [
        {
          id: 9001,
          amount: 2,
          sendType: 'IMMEDIATE',
          sendRequestAt: null,
          product: null, // 상품 삭제됨
          snapshotProductPrice: 5000, // 주문 시점 단가
        },
      ],
    } as any;
    const oneUser = { id: 5, allSettleAmount: 10000, company: null } as unknown as UserEntity;

    const { sut, orderRepository, userRepository } = buildSut(order, oneUser);

    await expect(
      sut.deliveryCancel({ id: 1 } as any, { id: 548, cancelReason: '예전 주문 정리' } as any),
    ).resolves.toBeUndefined();

    expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
    // legacy 흐름 환불: allSettleAmount -= totalPrice(5000 * 2)
    expect(oneUser.allSettleAmount).toBe(0);
    expect(orderRepository.save).toHaveBeenCalled();
    // ★ 미러는 통짜 save 가 아니라 DB 증감식으로 나간다 (197-16 리뷰 P1 — 동시 취소 lost update 차단).
    //   여신 복구이므로 all_settle_amount 가 환불액(5000 × 2)만큼 줄어야 한다.
    expect(userRepository.save).not.toHaveBeenCalled();
    expect(mirrorUpdates).toContainEqual(
      expect.objectContaining({
        column: 'allSettleAmount',
        sql: 'all_settle_amount + :allSettleDelta',
        params: { allSettleDelta: -10000 },
        where: { id: oneUser.id },
      }),
    );
  });
});
