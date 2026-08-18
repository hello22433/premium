import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';

/**
 * PR2-005 deliveryCancel wallet-managed branch.
 *
 * 시나리오:
 *  - wallet-managed 주문 (allocation 존재) → OrderConfirmationReleaseService.releaseConfirmation 호출 + legacy mirror reverse + user.balance 미기록.
 *  - legacy 주문 (allocation 부재) → 기존 path (user.balance/allSettleAmount 직접 가감) 유지.
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

describe('OrderService deliveryCancel wallet PR2-005 branch', () => {
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

  const createOrder = ({
    isCompany,
    isNewBillingFlow = true,
    settleAmount = 10000,
    isSettleBalance = true,
  }: {
    isCompany: boolean;
    isNewBillingFlow?: boolean;
    settleAmount?: number;
    isSettleBalance?: boolean;
  }) => {
    void isCompany;
    return {
      id: 555,
      userId: 1,
      clientUserId: 2,
      type: IOrderType.GENERAL,
      status: IOrderStatus.DELIVERY_CONFIRMED,
      isNewBillingFlow,
      settleAmount,
      isSettleBalance,
      isCreditExcess: false,
      cancelReason: null as string | null,
      canceledAt: null as Date | null,
      orderProductMappings: [
        {
          id: 10,
          amount: 1,
          product: { price: 10000 },
          sendType: 'RESERVE',
          sendRequestAt: new Date(Date.now() + 3600_000), // 1h later (>10min)
        },
      ],
    } as any;
  };

  const createService = ({
    isWalletManaged,
    allocation,
    company,
  }: {
    isWalletManaged: boolean;
    allocation?: any;
    company?: { balance: number };
  }) => {
    mirrorUpdates.length = 0;
    const service = Object.create(OrderService.prototype) as any;
    const order = createOrder({ isCompany: !!company });

    const billingUser = {
      id: 2,
      balance: 50000,
      allSettleAmount: 10000,
      companyId: company ? 1 : null,
      company: company
        ? {
            id: 1,
            balance: company.balance,
            balanceManagementType: 'COMPANY' as const,
          }
        : null,
    };

    const managedManager = {
      findOne: jest.fn().mockResolvedValue(allocation ?? null),
    };
    // 소유권(조회범위) 검증은 order.service.cancel-ownership.spec 에서 다룬다 — 여기선 통과시킨다.
    service.assertOrderInViewScope = jest.fn().mockResolvedValue(undefined);

    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(order),
      }),
      save: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: managedManager,
    };
    service.userRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(billingUser),
      save: jest.fn().mockResolvedValue(billingUser),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(mirrorBuilder),
    };
    service.userCompanyRepository = {
      save: jest.fn().mockResolvedValue(company),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(mirrorBuilder),
    };
    service.orderDeliveryRepository = {
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
    service.ssgEventService = { restoreEventBalance: jest.fn() };
    service.walletManagedPredicate = {
      isWalletManaged: jest.fn().mockResolvedValue(isWalletManaged),
    };
    service.orderConfirmationReleaseService = {
      releaseConfirmation: jest.fn().mockResolvedValue({
        alreadyReleased: false,
        walletTransactionIds: ['tx-1'],
        rolledBackAttemptIds: ['a-1'],
      }),
    };
    service.legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit: jest.fn() };

    return { service, order, billingUser, managedManager };
  };

  it('wallet-managed: releaseConfirmation 호출 + legacy mirror reverse + user.balance 미기록', async () => {
    const { service, order, billingUser, managedManager } = createService({
      isWalletManaged: true,
      allocation: {
        depositUsedAmount: 6000,
        depositRestoredAmount: 0,
        creditUsedAmount: 3000,
        creditUsedRestoredAmount: 0,
        creditExcessAmount: 1000,
        creditExcessRestoredAmount: 0,
      },
      company: { balance: 20000 },
    });

    await service.deliveryCancel({ id: 1 } as any, { id: order.id, cancelReason: 'oops' } as any);

    // releaseConfirmation called with order_cancel
    expect(service.orderConfirmationReleaseService.releaseConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: order.id,
        reason: 'order_cancel',
        failedDeliveryIds: null,
      }),
      managedManager,
    );

    // legacy mirror reverse
    expect(billingUser.company!.balance).toBe(20000 + 6000); // deposit refund
    expect(billingUser.allSettleAmount).toBe(10000 - (3000 + 1000)); // credit + excess
    expect(order.settleAmount).toBe(0);
    expect(order.isSettleBalance).toBe(false);
    expect(order.isCreditExcess).toBe(false);

    // ★ 미러는 DB 증감식으로 나간다 (197-16 리뷰 P1 — 동시 취소 lost update 차단).
    //   읽은 값을 되쓰면 같은 고객사의 다른 주문이 반영한 몫이 통째로 사라진다.
    //   user.balance 는 wallet path 에서 여전히 미기록 — 증감 대상이 아니다.
    expect(service.userRepository.save).not.toHaveBeenCalled();
    expect(mirrorUpdates).toEqual(
      expect.arrayContaining([
        // 여신·신용초과 복구 → all_settle_amount 감소
        expect.objectContaining({
          column: 'allSettleAmount',
          sql: 'all_settle_amount + :allSettleDelta',
          params: { allSettleDelta: -(3000 + 1000) },
          where: { id: billingUser.id },
        }),
        // 예치금 복구 → 회사 balance 증가
        expect.objectContaining({
          column: 'balance',
          sql: 'balance + :companyBalanceDelta',
          params: { companyBalanceDelta: 6000 },
          where: { id: billingUser.company!.id },
        }),
      ]),
    );
    expect(mirrorUpdates.some((u) => u.column === 'balance' && u.where?.id === billingUser.id)).toBe(false);

    // status flip + 배송 취소
    expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
    // ※ "이미 CANCEL 인 건·soft-delete 된 건 제외" 는 이제 조건부 UPDATE(CAS)의 WHERE 로 옮겨갔고,
    //   조건 전량은 cancel-multiline-baseline.spec 이 문자열로 고정한다. 여기서 repository.update 로
    //   확인하면 그 경로는 아무도 안 쓰므로 무엇을 해도 통과한다(아무것도 안 지키는 단언).
    expect(service.orderDeliveryRepository.update).not.toHaveBeenCalled();
  });

  it('legacy-managed (allocation 부재): 기존 path — user.balance 가감', async () => {
    const { service, order, billingUser } = createService({
      isWalletManaged: false,
    });

    await service.deliveryCancel({ id: 1 } as any, { id: order.id, cancelReason: 'manual' } as any);

    // releaseConfirmation 호출 0건
    expect(service.orderConfirmationReleaseService.releaseConfirmation).not.toHaveBeenCalled();

    // 기존 path: isSettleBalance=true → balance 환원
    expect(billingUser.balance).toBe(50000 + 10000); // refundAmount = settleAmount = 10000
    expect(order.isSettleBalance).toBe(false);
    // ★ 통짜 save 가 아니라 증감식으로 나간다 (197-16 리뷰 P1).
    expect(service.userRepository.save).not.toHaveBeenCalled();
    expect(mirrorUpdates).toContainEqual(
      expect.objectContaining({
        column: 'balance',
        sql: 'balance + :userBalanceDelta',
        params: { userBalanceDelta: 10000 },
        where: { id: billingUser.id },
      }),
    );
    // legacy 예치금 복구는 wallet 동기화(syncDeposit) 를 동반 (billingUserId=clientUserId=2).
    expect(service.legacyWalletCreditSyncService.syncDeposit).toHaveBeenCalledWith(
      service.orderRepository.manager,
      expect.objectContaining({
        billingUserId: 2,
        orderId: order.id,
        delta: 10000,
        type: 'DISCARD_REFUND',
        idempotencyKey: `legacy_discard_refund:${order.id}:deposit`,
      }),
    );
    expect(service.legacyWalletCreditSyncService.syncCredit).not.toHaveBeenCalled();
  });

  it('발송확정 전(REVIEW_COMPLETE) 은 allocation 이 없어 wallet path 를 타지 않는다', async () => {
    // 이 상태에서는 차감 자체가 없어 allocation 이 만들어지지 않는다 → isWalletManaged=false.
    // 종전에는 `refundAmount > 0 &&` 단락으로 판정 쿼리조차 안 던졌지만, 그건 구현 세부사항이고
    // 계약은 "allocation 이 없으면 wallet path 를 안 탄다" 이다. 그쪽을 고정한다.
    const { service, order } = createService({
      isWalletManaged: false,
      allocation: { depositUsedAmount: 0, depositRestoredAmount: 0 },
    });
    order.status = IOrderStatus.REVIEW_COMPLETE;
    order.settleAmount = 0;

    await service.deliveryCancel({ id: 1 } as any, { id: order.id, cancelReason: 'pre-confirm' } as any);

    expect(service.orderConfirmationReleaseService.releaseConfirmation).not.toHaveBeenCalled();
  });

  /**
   * ★ 리뷰 P2 — 0원 주문의 allocation 이 열린 채 남던 결함.
   *
   * 종전 라우팅은 `refundAmount > 0 && isWalletManaged(...)` 였다. && 는 왼쪽이 거짓이면 오른쪽을
   * 실행하지 않으므로, settleAmount=0 인 주문은 **지갑을 쓰는 주문인지 물어보지도 않고** 지갑 경로를
   * 건너뛴다. 그러면 releaseConfirmation 이 호출되지 않아 allocation.released_at 이 NULL 로 남는다.
   * 주문·발송건은 CANCEL 인데 지갑만 "아직 진행 중" 인 상태가 되고, 이후 경로들이 이 주문을 계속
   * 미결로 본다.
   *
   * 0원이 나오는 실제 경로: 무료·100% 할인 잔여분, 부분취소 후 남은 것이 0원인 경우.
   * releaseConfirmation 은 restore 금액이 0 이면 지갑을 건드리지 않고 released_at 만 찍으므로
   * (order-confirmation-release.service.ts `if (restoreDeposit > 0)`) 0원에 호출해도 안전하다.
   */
  it('발송확정 후 0원 주문도 wallet path 를 타서 allocation 을 닫는다', async () => {
    const { service, order } = createService({
      isWalletManaged: true,
      // 이미 전액 복구돼 돌려줄 것이 없는 allocation — 그래도 닫아야 한다
      allocation: { depositUsedAmount: 10000, depositRestoredAmount: 10000 },
    });
    order.status = IOrderStatus.DELIVERY_CONFIRMED;
    order.settleAmount = 0;

    await service.deliveryCancel({ id: 1 } as any, { id: order.id, cancelReason: '잔여분 취소' } as any);

    expect(service.orderConfirmationReleaseService.releaseConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: order.id, reason: 'order_cancel' }),
      expect.anything(),
    );
  });
});
