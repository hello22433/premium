// ★ requireActual 스프레드 필수: import 그래프 내 다른 서비스가 Propagation 등 다른 export 를
//   클래스정의 시점에 쓰므로, 전체 모듈을 덮으면 로드가 깨진다.
jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { In } from 'typeorm';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

/**
 * 다중 상품행 주문의 **현행(전체취소) 동작 기준선**.
 *
 * 왜 필요한가: 기존 취소 스펙 4종의 fixture 는 전부 "상품행 1개 · amount 1" 이다.
 * 단일 라인에서는 "주문 전액 환불" 과 "올바른 부분 환불" 의 금액이 우연히 같아서,
 * 부분취소 배선 후 실수로 전액을 환불해도 그 스펙들은 전부 통과한다 —
 * 회귀 안전망이 정확히 가장 중요한 실패를 못 잡는다.
 *
 * 여기서는 상품행 2개(수량 1 + 2, 예약시각도 다름) 주문으로 현행 동작을 못박는다.
 * 부분취소 전환 커밋에서 이 스펙의 어떤 단언이 깨지는지가 곧 "무엇이 바뀌었는가" 다.
 *
 * ※ 전환 시 예상되는 변화(그때 이 파일을 함께 갱신할 것):
 *    - 취소 대상이 전체 발송건 → 선택된 발송건으로 좁혀진다
 *    - 환불액이 settleAmount 전액 → 취소분만큼으로 바뀐다
 *    - 잔여 발송건이 남으면 order.status 는 DELIVERY_CANCEL 이 되지 않는다
 */
describe('OrderService.deliveryCancel — 다중 상품행 주문 현행 동작 (전환 전 기준선)', () => {
  const MAPPING_A = 501; // 수량 1, 1시간 뒤 예약
  const MAPPING_B = 502; // 수량 2, 3시간 뒤 예약
  const SETTLE_AMOUNT = 30000;

  const buildSut = () => {
    const order = {
      id: 1001,
      userId: 5,
      clientUserId: null,
      type: IOrderType.GENERAL,
      status: IOrderStatus.DELIVERY_CONFIRMED,
      isNewBillingFlow: true,
      settleAmount: SETTLE_AMOUNT,
      isSettleBalance: false,
      isCreditExcess: false,
      cancelReason: null as string | null,
      canceledAt: null as Date | null,
      orderProductMappings: [
        {
          id: MAPPING_A,
          amount: 1,
          product: { price: 10000 },
          sendType: 'RESERVE',
          sendRequestAt: new Date(Date.now() + 3600_000),
        },
        {
          id: MAPPING_B,
          amount: 2,
          product: { price: 10000 },
          sendType: 'RESERVE',
          sendRequestAt: new Date(Date.now() + 3 * 3600_000),
        },
      ],
    } as any;

    const oneUser = { id: 5, balance: 50000, allSettleAmount: 30000, companyId: null, company: null } as any;

    const allocation = {
      orderId: order.id,
      depositUsedAmount: 20000,
      depositRestoredAmount: 0,
      creditUsedAmount: 10000,
      creditUsedRestoredAmount: 0,
      creditExcessAmount: 0,
      creditExcessRestoredAmount: 0,
    };

    const externalManager = { findOne: jest.fn().mockResolvedValue(allocation) };

    const sut: any = Object.create(OrderService.prototype);
    sut.orderRepository = {
      createQueryBuilder: jest.fn(() => {
        const b: any = {
          setLock: () => b,
          leftJoinAndSelect: () => b,
          where: () => b,
          getOne: async () => order,
        };
        return b;
      }),
      save: jest.fn(async () => order),
      manager: externalManager,
    };
    sut.userRepository = {
      findOneOrFail: jest.fn(async () => oneUser),
      save: jest.fn(async () => oneUser),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    sut.userCompanyRepository = { save: jest.fn() };
    sut.orderDeliveryRepository = {
      update: jest.fn(async () => ({ affected: 3 })),
      createQueryBuilder: () => {
        const b: any = { innerJoin: () => b, where: () => b, andWhere: () => b, getCount: async () => 0 };
        return b;
      },
    };
    sut.ssgEventService = { restoreEventBalance: jest.fn() };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn(async () => true) };
    sut.orderConfirmationReleaseService = {
      releaseConfirmation: jest.fn(async () => ({ alreadyReleased: false, walletTransactionIds: ['tx-1'] })),
    };
    sut.legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit: jest.fn() };
    sut.orderCancelNotificationService = { notifyDirectOrderCancel: jest.fn() };

    return { sut, order, oneUser };
  };

  const body = { id: 1001, cancelReason: '고객 요청' };

  it('[현행] 상품행이 여러 개여도 주문 전체가 취소된다', async () => {
    const { sut, order } = buildSut();

    await sut.deliveryCancel({ id: 1 }, body);

    expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
    expect(order.cancelReason).toBe('고객 요청');
    expect(order.canceledAt).toBeInstanceOf(Date);
  });

  // ★ 전환 시 가장 먼저 깨져야 하는 단언. 지금은 상품행 전체를 조건 없이 CANCEL 로 덮는다.
  //   부분취소가 배선되면 선택된 발송건만, 그것도 CAS 조건과 함께 갱신되어야 한다.
  it('[현행] 모든 상품행의 발송건을 조건 없이 CANCEL 로 덮는다', async () => {
    const { sut } = buildSut();

    await sut.deliveryCancel({ id: 1 }, body);

    expect(sut.orderDeliveryRepository.update).toHaveBeenCalledWith(
      { orderProductMappingId: In([MAPPING_A, MAPPING_B]) },
      // 발송건에도 취소 시각·사유를 남긴다(전체취소도 부분취소와 동일하게 채운다 —
      // canceled_at IS NULL 이 "미취소" 와 "전체취소" 를 겸하지 않도록).
      { status: IOrderDeliveryStatus.CANCEL, canceledAt: expect.any(Date), cancelReason: expect.any(String) },
    );
  });

  // ★ 단일 라인 fixture 로는 이 차이가 드러나지 않는다.
  //   전액(30000) 과 "A 만 취소했을 때의 올바른 금액(10000)" 이 다른 구성이라야
  //   전환 후 실수로 전액을 환불하는 회귀가 잡힌다.
  it('[현행] 환불은 특정 상품행이 아니라 주문 전액(settleAmount) 기준이다', async () => {
    const { sut, order } = buildSut();

    await sut.deliveryCancel({ id: 1 }, body);

    expect(sut.orderConfirmationReleaseService.releaseConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 1001, reason: 'order_cancel', failedDeliveryIds: null }),
      expect.anything(),
    );
    // 전액 보상 후 주문의 정산금액이 0 으로 초기화된다 —
    // 부분취소에서는 잔여분이 살아 있으므로 이 초기화를 하면 안 된다.
    expect(order.settleAmount).toBe(0);
    expect(order.isSettleBalance).toBe(false);
  });

  // 10분 게이트는 예약(RESERVE) 상품행들의 sendRequestAt 최솟값 하나로 주문 전체를 판정한다.
  // 여기서는 가장 이른 A(1시간 뒤)가 기준이 되어 통과한다.
  it('[현행] 10분 게이트는 가장 이른 예약시각 하나로 주문 전체를 판정한다', async () => {
    const { sut, order } = buildSut();
    order.orderProductMappings[0].sendRequestAt = new Date(Date.now() + 60_000); // A 를 1분 뒤로

    await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toThrow(/10분 전까지만/);
  });

  it('[현행] 늦은 상품행(B)이 여유가 있어도 A 가 임박하면 주문 전체가 막힌다', async () => {
    const { sut, order } = buildSut();
    order.orderProductMappings[0].sendRequestAt = new Date(Date.now() + 60_000); // A 임박
    order.orderProductMappings[1].sendRequestAt = new Date(Date.now() + 24 * 3600_000); // B 는 하루 뒤

    // 이것이 티켓 197-16 이 해결하려는 증상이다 — B 만 취소할 방법이 없다.
    await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toThrow(/10분 전까지만/);
  });
});
