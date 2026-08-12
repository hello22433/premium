// ★ requireActual 스프레드 필수: import 그래프 내 다른 서비스가 Propagation 등 다른 export 를
//   클래스정의 시점에 쓰므로, 전체 모듈을 덮으면 로드가 깨진다.
jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { ConflictException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';

/**
 * 전체취소가 "이미 나간 건" 을 덮지 않도록 하는 가드.
 *
 * 배경: 10분 게이트는 sendType === 'RESERVE' 인 상품행만 본다. 그래서
 * 즉시발송 상품행(이미 발송완료) + 예약 상품행(아직 대기) 이 섞인 주문은, 예약분의 여유만 보고
 * 게이트를 통과한다. 그 뒤 실행부가 주문의 모든 발송건을 상태 무관하게 CANCEL 로 덮고
 * settleAmount 전액을 환불하므로, 이미 고객 손에 간 쿠폰이 취소되고 그 몫까지 환불된다
 * (응답 200, 로그 없음). 부분취소 기능과 별개로 지금 재현 가능한 결함이다.
 *
 * 가드는 발송확정(DELIVERY_CONFIRMED) 이후에만 건다 — 그 전에는 발송건이 TEMP 라
 * 나간 것이 있을 수 없고 잔액 차감도 없어서, 검사를 걸면 정상 취소만 막힌다.
 */
describe('OrderService.deliveryCancel — 되돌릴 수 없는 발송건 가드', () => {
  const buildSut = ({
    status,
    irreversibleCount,
    /** 아직 취소되지 않은 발송건이 남아 있는 상품행 id. 미지정이면 둘 다 살아 있다. */
    activeMappingIds = [501, 502],
    /** 예약 상품행(502)의 예약시각. 기본은 하루 뒤(게이트 통과). */
    reserveSendRequestAt = new Date(Date.now() + 24 * 3600_000),
    /** CAS 뒤에도 취소되지 않고 남은 발송건 수(사후검사용). 기본 0 = 전부 취소됨. */
    leftoverAfterCancel = 0,
  }: {
    status: IOrderStatus;
    irreversibleCount: number;
    activeMappingIds?: number[];
    reserveSendRequestAt?: Date;
    leftoverAfterCancel?: number;
  }) => {
    const order = {
      id: 1001,
      userId: 5,
      clientUserId: null,
      type: IOrderType.GENERAL,
      status,
      isNewBillingFlow: true,
      settleAmount: 30000,
      isSettleBalance: false,
      isCreditExcess: false,
      cancelReason: null as string | null,
      canceledAt: null as Date | null,
      orderProductMappings: [
        // 즉시발송 상품행 — 이미 나갔다고 가정하는 쪽
        { id: 501, amount: 1, product: { price: 10000 }, sendType: 'IMMEDIATE', sendRequestAt: null },
        // 예약 상품행 — 하루 뒤라 10분 게이트를 통과시킨다
        {
          id: 502,
          amount: 2,
          product: { price: 10000 },
          sendType: 'RESERVE',
          sendRequestAt: reserveSendRequestAt,
        },
      ],
    } as any;

    const oneUser = { id: 5, balance: 50000, allSettleAmount: 30000, companyId: null, company: null } as any;

    const getCount = jest.fn(async () => irreversibleCount);
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
      manager: { findOne: jest.fn(async () => null) },
    };
    sut.userRepository = {
      findOneOrFail: jest.fn(async () => oneUser),
      save: jest.fn(async () => oneUser),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    sut.userCompanyRepository = { save: jest.fn() };
    // ★ 조건식을 캡처한다. getCount 만 스텁하면 판정 조건을 통째로 지워도 전부 통과해
    //   "되돌릴 수 없는 건" 의 정의가 아무것도 고정되지 않는다(뮤테이션으로 확인된 공백).
    const guardConditions: string[] = [];
    // 전체취소의 발송건 CANCEL 은 이제 조건부 UPDATE(CAS)다 — 실행 여부를 여기서 센다.
    // repository.update 는 더 이상 호출되지 않으므로 그것으로 "안 덮었다" 를 확인하면
    // 무엇을 해도 통과한다(아무것도 안 지키는 단언이 된다).
    const cancelExecutes: Array<{ conditions: string[]; set: Record<string, unknown> }> = [];
    sut.orderDeliveryRepository = {
      update: jest.fn(async () => ({ affected: 3 })),
      createQueryBuilder: jest.fn(() => {
        let isUpdate = false;
        // ★ getCount 를 쓰는 쿼리가 **두 종류**다 — 되돌릴 수 없는 건을 세는 가드(innerJoin 사용)와,
        //   CAS 뒤 "취소 안 된 게 남았나" 를 묻는 사후검사(innerJoin 없음).
        //   구분하지 않으면 "발송확정 전에는 가드를 안 본다" 가 사후검사 호출 때문에 깨진다 —
        //   테스트가 잘못된 게 아니라 목이 두 쿼리를 같은 것으로 본 것이다.
        let joined = false;
        let setValues: Record<string, unknown> = {};
        const own: string[] = [];
        const b: any = {
          innerJoin: () => {
            joined = true;
            return b;
          },
          select: () => b,
          update: () => {
            isUpdate = true;
            return b;
          },
          set: (v: Record<string, unknown>) => {
            setValues = v;
            return b;
          },
          where: (cond: string) => {
            if (isUpdate) own.push(cond);
            return b;
          },
          andWhere: (cond: string) => {
            (isUpdate ? own : guardConditions).push(cond);
            return b;
          },
          execute: async () => {
            cancelExecutes.push({ conditions: own, set: setValues });
            return { affected: 3 };
          },
          // 사후검사(innerJoin 없음)는 leftoverAfterCancel 을 돌려준다 = 취소 안 된 발송건 수.
          getCount: async () => (joined ? getCount() : leftoverAfterCancel),
          // findMappingIdsWithActiveDeliveries 용 — "아직 취소 안 된 발송건이 있는 상품행" 목록
          getRawMany: async () => activeMappingIds.map((mappingId) => ({ mappingId })),
        };
        return b;
      }),
    };
    sut.__guardConditions = guardConditions;
    sut.__cancelExecutes = cancelExecutes;
    sut.ssgEventService = { restoreEventBalance: jest.fn() };
    sut.walletManagedPredicate = { isWalletManaged: jest.fn(async () => false) };
    sut.legacyWalletCreditSyncService = { syncCredit: jest.fn(), syncDeposit: jest.fn() };
    sut.orderCancelNotificationService = { notifyDirectOrderCancel: jest.fn() };
    sut.logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };

    return { sut, order, getCount };
  };

  const body = { id: 1001, cancelReason: '고객 요청' };

  // ★ 이 케이스가 이번 수정의 핵심이다. 가드가 없으면 200 으로 통과하면서
  //   이미 나간 쿠폰까지 CANCEL 로 덮고 전액 환불한다.
  it('즉시발송분이 이미 나간 혼재 주문의 전체취소를 거부한다', async () => {
    const { sut } = buildSut({ status: IOrderStatus.DELIVERY_CONFIRMED, irreversibleCount: 1 });

    await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toBeInstanceOf(ConflictException);
  });

  it('거부 시 아무것도 취소하지 않고 환불도 하지 않는다', async () => {
    const { sut, order } = buildSut({ status: IOrderStatus.DELIVERY_CONFIRMED, irreversibleCount: 1 });

    await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toBeInstanceOf(ConflictException);

    // ★ 조건부 UPDATE 자체가 실행되지 않아야 한다. repository.update 로 확인하면 그 경로는
    //   이제 아무도 안 쓰므로 코드를 어떻게 망가뜨려도 통과한다.
    expect(sut.__cancelExecutes).toHaveLength(0);
    expect(sut.userRepository.save).not.toHaveBeenCalled();
    expect(order.status).toBe(IOrderStatus.DELIVERY_CONFIRMED);
  });

  // ★ 사전 조회는 **그 순간의 사진**이다. 0 건을 확인한 직후에도 발송 배치가 WAIT 행을 집어
  //   발급·발송을 시작할 수 있다. 그때 CAS 의 재검사 조건에 걸려 그 행만 안 바뀌는데, 환불은
  //   주문 전액으로 나간다 — "전체취소" 가 아닌데 전액을 돌려주는 상태가 된다.
  //   그래서 갱신 뒤에 **결과를 다시 묻는다**: 취소 안 된 발송건이 0 건이어야 한다.
  //   (갱신 건수를 비교하지 않는 이유는 전체취소가 "몇 건을 취소할지" 를 모르기 때문이다)
  it('갱신 뒤에도 취소 안 된 발송건이 남으면 던져서 되돌린다 (조회~갱신 사이 경합)', async () => {
    const { sut, order } = buildSut({
      status: IOrderStatus.DELIVERY_CONFIRMED,
      irreversibleCount: 0, // 사전 조회 시점엔 깨끗했다
      leftoverAfterCancel: 1, // 그 사이 1건이 발송 단계로 넘어가 CAS 에서 빠졌다
    });

    await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toBeInstanceOf(ConflictException);
    expect(sut.logger.error).toHaveBeenCalledWith(expect.stringContaining('ORDER_CANCEL_PARTIAL_UPDATE'));
    // ★ 사후검사는 잔액 복원 **앞**에 있어야 한다. 뒤에 있으면 이미 돈이 나간 뒤라 던져도 늦다.
    //   (트랜잭션 롤백 자체는 @Transactional 소관이고 이 목에서는 관측할 수 없다 — order.status 는
    //    메모리 객체라 되돌아오지 않으므로 그것으로 확인하면 안 된다)
    expect(sut.userRepository.save).not.toHaveBeenCalled();
    expect(sut.userCompanyRepository.save).not.toHaveBeenCalled();
  });

  it('거부 메시지에 몇 건이 걸렸는지 알려준다', async () => {
    const { sut } = buildSut({ status: IOrderStatus.DELIVERY_CONFIRMED, irreversibleCount: 3 });

    await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toThrow(/3건/);
  });

  // ★ "되돌릴 수 없다" 의 정의 자체를 고정한다. getCount 만 스텁하면 이 조건들을 지워도
  //   위 케이스들이 전부 통과한다 — 그러면 이미 나간 쿠폰이 CANCEL 로 덮이고 전액 환불된다.
  it.each([
    ['실제 발송됨', 'od.actualSendAt IS NOT NULL'],
    ['쿠폰 발급됨(초이스/이메일)', 'od.couponIssuedAt IS NOT NULL'],
    ['PIN 발급됨(일반 배치)', 'od.barCode IS NOT NULL'],
    ['배치가 소유권을 잡음', 'od.claimedAt IS NOT NULL'],
  ])('되돌릴 수 없는 조건에 %s 를 포함한다', async (_caseName, fragment) => {
    const { sut } = buildSut({ status: IOrderStatus.DELIVERY_CONFIRMED, irreversibleCount: 0 });

    await sut.deliveryCancel({ id: 1 }, body);

    expect(sut.__guardConditions.join(' ')).toContain(fragment);
  });

  it('되돌릴 수 없는 건이 없으면 종전대로 전체취소가 진행된다', async () => {
    const { sut, order } = buildSut({ status: IOrderStatus.DELIVERY_CONFIRMED, irreversibleCount: 0 });

    await sut.deliveryCancel({ id: 1 }, body);

    expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
    expect(sut.__cancelExecutes).toHaveLength(1);
  });

  // 발송확정 전에는 발송건이 TEMP 라 나간 것이 있을 수 없고 잔액 차감도 없다.
  // 여기에 가드를 걸면 정상 취소만 막히므로 검사 자체를 하지 않는다.
  it.each([
    ['주문완료', IOrderStatus.DELIVERY_REQUEST],
    ['검토완료', IOrderStatus.REVIEW_COMPLETE],
  ])('발송확정 전(%s) 에는 가드를 검사하지 않는다', async (_caseName, status) => {
    const { sut, order, getCount } = buildSut({ status, irreversibleCount: 99 });

    await sut.deliveryCancel({ id: 1 }, body);

    expect(getCount).not.toHaveBeenCalled();
    expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
  });

  /**
   * 10분 컷오프는 예약 상품행들의 sendRequestAt 중 **가장 이른 시각**으로 판정한다.
   * 부분취소가 "예약시각은 지났는데 발송은 안 된(=취소된) 상품행" 을 처음 만들면서, 그 지난 시각이
   * 최솟값을 영구히 과거로 끌어내리는 조합이 생겼다. 그러면 아직 여유가 충분한 나머지 예약건까지
   * 전체취소가 **영원히** 400 이 된다 — 시간이 갈수록 더 과거가 되므로 회복 경로가 없다.
   */
  describe('컷오프 판정에서 이미 취소된 상품행 제외 (리뷰 P2)', () => {
    // 502(예약)만 살아 있고 501 은 취소된 상황을 만들기 위해, 지난 시각을 가진 쪽을 501 로 둘 수 없어
    // (501 은 즉시발송) 예약행 502 자체의 시각을 과거로 두고 "502 는 취소됨" 으로 표현한다.
    it('취소된 예약행의 지난 시각 때문에 막히지 않는다', async () => {
      const { sut, order } = buildSut({
        status: IOrderStatus.DELIVERY_CONFIRMED,
        irreversibleCount: 0,
        // 예약행 502 의 예약시각이 이미 2시간 지났다 — 부분취소로 발송건이 전부 CANCEL 된 상태
        reserveSendRequestAt: new Date(Date.now() - 2 * 3600_000),
        // 살아 있는 발송건은 즉시행 501 에만 있다(502 는 전부 취소됨)
        activeMappingIds: [501],
      });

      await sut.deliveryCancel({ id: 1 }, body);

      expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
    });

    it('살아 있는 예약행이 임박하면 종전대로 거부한다 (가드가 사라지지 않았다)', async () => {
      const { sut } = buildSut({
        status: IOrderStatus.DELIVERY_CONFIRMED,
        irreversibleCount: 0,
        // 5분 뒤 — 10분 컷오프 안쪽
        reserveSendRequestAt: new Date(Date.now() + 5 * 60_000),
        activeMappingIds: [501, 502],
      });

      await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toThrow('10분 전까지만');
    });

    it('살아 있는 예약건이 하나도 없으면 컷오프를 적용하지 않는다', async () => {
      const { sut, order } = buildSut({
        status: IOrderStatus.DELIVERY_CONFIRMED,
        irreversibleCount: 0,
        reserveSendRequestAt: new Date(Date.now() - 2 * 3600_000),
        // 어느 상품행에도 살아 있는 발송건이 없다 → 보호할 예약건이 없다
        activeMappingIds: [],
      });

      await sut.deliveryCancel({ id: 1 }, body);

      expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
    });
  });
});
