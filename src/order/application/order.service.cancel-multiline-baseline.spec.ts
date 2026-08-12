// ★ requireActual 스프레드 필수: import 그래프 내 다른 서비스가 Propagation 등 다른 export 를
//   클래스정의 시점에 쓰므로, 전체 모듈을 덮으면 로드가 깨진다.
jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { In, IsNull, Not } from 'typeorm';
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
    // 소유권(조회범위) 검증은 order.service.cancel-ownership.spec 에서 다룬다 — 여기선 통과시킨다.
    sut.assertOrderInViewScope = jest.fn().mockResolvedValue(undefined);
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
    // 레거시 미러는 이제 DB 증감식 UPDATE 다 — set 에 넘긴 SQL 조각과 파라미터를 캡처한다.
    const mirrorUpdates: Array<{ set: Record<string, () => string>; params: unknown; where: unknown }> = [];
    const makeMirrorBuilder = () => () => {
      const captured = { set: {}, params: null, where: null } as any;
      const mb: any = {
        update: () => mb,
        set: (v: any) => {
          captured.set = v;
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
    sut.userRepository = {
      findOneOrFail: jest.fn(async () => oneUser),
      save: jest.fn(async () => oneUser),
      update: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn(makeMirrorBuilder()),
    };
    sut.userCompanyRepository = { save: jest.fn(), createQueryBuilder: jest.fn(makeMirrorBuilder()) };
    sut.__mirrorUpdates = mirrorUpdates;
    // 전체취소의 발송건 CANCEL 은 조건부 UPDATE(CAS)다 — 조건과 SET 을 캡처해 단언한다.
    const cancelUpdate = { conditions: [] as string[], set: {} as Record<string, unknown>, executed: 0 };
    sut.__cancelUpdate = cancelUpdate;
    sut.orderDeliveryRepository = {
      update: jest.fn(async () => ({ affected: 3 })),
      createQueryBuilder: () => {
        // select/getRawMany 는 findMappingIdsWithActiveDeliveries(취소된 상품행을 컷오프에서 제외) 용.
        // 이 스펙들은 취소된 행이 없는 상황이라 상품행 전부를 살아 있는 것으로 돌려준다.
        let isUpdate = false;
        const b: any = {
          innerJoin: () => b,
          select: () => b,
          update: () => {
            isUpdate = true;
            return b;
          },
          set: (v: Record<string, unknown>) => {
            cancelUpdate.set = v;
            return b;
          },
          where: (cond: string) => {
            if (isUpdate) cancelUpdate.conditions.push(cond);
            return b;
          },
          andWhere: (cond: string) => {
            if (isUpdate) cancelUpdate.conditions.push(cond);
            return b;
          },
          execute: async () => {
            cancelUpdate.executed += 1;
            return { affected: 3 };
          },
          // CAS 뒤 "취소 안 된 발송건이 남았나" 사후검사 — 이 스펙은 남는 것이 없는 상황이다.
          getCount: async () => 0,
          getRawMany: async () => (order.orderProductMappings ?? []).map((m: any) => ({ mappingId: m.id })),
        };
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

  // 전체취소는 상품행 전체의 발송건을 CANCEL 로 덮는다. 단 **이미 CANCEL 인 행과 soft-delete 된 행은
  // 제외**한다.
  //   · status != CANCEL : 부분취소로 먼저 취소된 발송건이 있는 주문을 이어서 전체취소하면(도달 가능 —
  //     부분취소는 주문을 DELIVERY_CONFIRMED 로 남긴다) 조건이 없을 때 그 건의 사유·시각이 전체취소
  //     값으로 덮여 발송건별 취소이력이 사라진다. 발송건 단위 컬럼을 만든 이유가 그대로 무너진다.
  //     (로컬 QA 에서 실제 재현 → 조건 추가로 해소)
  //   · deletedAt IS NULL : update() 는 soft-delete 필터를 자동 적용하지 않는다.
  it('전체취소는 이미 취소된 건·삭제된 건을 제외하고 CANCEL 로 덮는다', async () => {
    const { sut } = buildSut();

    await sut.deliveryCancel({ id: 1 }, body);

    const { conditions, set } = sut.__cancelUpdate;
    expect(sut.__cancelUpdate.executed).toBe(1);

    const sql = conditions.join(' | ');
    expect(sql).toContain('orderProductMappingId IN (:...mappingIds)');
    expect(sql).toContain('status != :canceled'); // 이미 취소된 건의 사유·시각을 덮지 않는다
    expect(sql).toContain('deletedAt IS NULL'); // soft-delete 된 행은 건드리지 않는다
    // ★ 사전 조회는 그 순간의 사진일 뿐이라, 갱신도 같은 신호를 다시 봐야 한다(197-16 리뷰 P1).
    //   하나라도 빠지면 조회~갱신 사이에 발송 단계로 넘어간 건까지 덮고 전액 환불한다.
    expect(sql).toContain('actualSendAt IS NOT NULL');
    expect(sql).toContain('couponIssuedAt IS NOT NULL');
    expect(sql).toContain('barCode IS NOT NULL');
    expect(sql).toContain('claimedAt IS NOT NULL');
    expect(sql).toContain('mutationClaimedAt < :mutationStale');

    // 발송건에도 취소 시각·사유를 남긴다(전체취소도 부분취소와 동일하게 채운다 —
    // canceled_at IS NULL 이 "미취소" 와 "전체취소" 를 겸하지 않도록).
    // mutationClaimedAt 은 통과시킨 stale lease 를 탈취해 좀비의 뒤늦은 쓰기를 막는 값이다.
    expect(set).toEqual({
      status: IOrderDeliveryStatus.CANCEL,
      canceledAt: expect.any(Date),
      cancelReason: expect.any(String),
      mutationClaimedAt: expect.any(Date),
    });
  });

  // ★ 레거시 미러(회사 예치금 / 사용자 예치금·여신)는 **DB 증감식**으로 반영해야 한다.
  //   읽은 값 + 델타를 되쓰면(`balance = 60000`) 같은 고객사의 **다른 주문**이 동시에 취소될 때
  //   둘 다 같은 옛 값을 읽고 각자 더해 되쓰므로 나중 커밋이 앞의 반영을 통째로 덮는다.
  //   지갑 원장은 두 건 다 맞는데 화면·정산 잔액만 한 건분 모자란다 — 에러도 로그도 없는 사고다.
  //   `x = x + :delta` 로 넘기면 UPDATE 가 행 락 안에서 현재값 기준으로 계산해 유실이 사라진다.
  //   ※ 문구가 아니라 **형태**(SQL 조각 안에 컬럼명이 다시 등장하는가)를 본다 — 절대값으로
  //     되돌리면 그 조건이 곧바로 깨진다.
  it('레거시 미러는 절대값이 아니라 증감식으로 반영한다 (동시 취소 유실 차단)', async () => {
    const { sut } = buildSut();

    await sut.deliveryCancel({ id: 1 }, body);

    const updates = sut.__mirrorUpdates as Array<{ set: Record<string, () => string>; params: any }>;
    expect(updates.length).toBeGreaterThan(0);

    for (const u of updates) {
      const [column, expression] = Object.entries(u.set)[0];
      // set 에 넘긴 값이 **함수**여야 SQL 조각으로 나간다. 값이면 절대값 저장이다.
      expect(typeof expression).toBe('function');
      const sql = (expression as () => string)();
      // `all_settle_amount + :allSettleDelta` 처럼 자기 컬럼을 다시 읽는 형태여야 한다.
      expect(sql).toMatch(/^(all_settle_amount|balance) [+-] :/);
      expect(column).toMatch(/^(allSettleAmount|balance)$/);
      // 델타는 파라미터로 넘어간다 — 값이 SQL 에 박히면 안 된다(바인딩 유지).
      expect(u.params).toBeTruthy();
    }
  });

  // ★ 통짜 save 로 되돌아가면 이 트랜잭션이 건드리지도 않은 컬럼까지 락 없이 읽은 스냅샷으로
  //   덮어쓴다. 위 증감식 단언과 짝으로 둔다 — 형태만 보면 save 가 남아 있어도 통과하기 때문이다.
  it('잔액 엔티티를 통째로 save 하지 않는다', async () => {
    const { sut } = buildSut();

    await sut.deliveryCancel({ id: 1 }, body);

    expect(sut.userRepository.save).not.toHaveBeenCalled();
    expect(sut.userCompanyRepository.save).not.toHaveBeenCalled();
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
