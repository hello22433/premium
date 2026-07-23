// ★ requireActual 스프레드 필수: import 그래프 내 다른 서비스가 Propagation 등 다른 export 를
//   클래스정의 시점에 쓰므로, 전체 모듈을 덮으면 로드가 깨진다.
jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderPaymentRefundEventType } from '../../entity/order.payment.refund.event.entity';
import { calculateOrderSettlementAmount } from '../../util/settle-fee.util';

/**
 * 예약 발송건 부분취소 (197-16).
 *
 * 취소 대상 판정과 CAS 자체는 각각 cancelable-deliveries / cancel-cas 스펙이 지킨다.
 * 여기서는 그것들을 엮은 **경로 전체의 계약**을 고정한다 — 무엇을 거부하고, 무엇을 취소하고,
 * 얼마를 환불하고, 주문 상태를 언제 내리는가.
 */
describe('OrderService.deliveryCancel — 예약 발송건 부분취소', () => {
  const ORDER_ID = 1001;
  const CANCELABLE = [9003, 9004, 9005]; // 대기 중 (취소 가능)
  const ALREADY_SENT = 9001; // 이미 발송됨 (취소 불가)

  const buildSut = (
    over: {
      status?: IOrderStatus;
      type?: IOrderType;
      isWalletManaged?: boolean;
      cancelableIds?: number[];
      remainingAfterCancel?: number;
      alreadyRefunded?: boolean;
      settleAmount?: number;
      refundBreakdown?: { deposit: number; credit: number; excess: number };
      balanceManagementType?: string;
      authority?: string;
      survivingMappings?: any[];
    } = {},
  ) => {
    const order = {
      id: ORDER_ID,
      userId: 5,
      clientUserId: null,
      code: 'ORD-1001',
      eventName: '여름 프로모션',
      status: over.status ?? IOrderStatus.DELIVERY_CONFIRMED,
      type: over.type ?? IOrderType.GENERAL,
      settleAmount: over.settleAmount ?? 100000,
      cardSurchargeApplied: false,
      isSettleBalance: true,
      isCreditExcess: false,
      cancelReason: null as string | null,
      canceledAt: null as Date | null,
    } as any;

    // 환불 전/후 allocation. 재원별 복구액은 이 차이로 읽는다.
    const allocation = {
      orderId: ORDER_ID,
      depositRestoredAmount: 0,
      creditUsedRestoredAmount: 0,
      creditExcessRestoredAmount: 0,
    };
    const refundBreakdown = over.refundBreakdown ?? { deposit: 30000, credit: 0, excess: 0 };

    const cancelableIds = over.cancelableIds ?? CANCELABLE;
    const remaining = over.remainingAfterCancel ?? 2; // 기본: 발송완료 2건이 남아 있다

    const sut: any = Object.create(OrderService.prototype);

    // 전체취소 경로만 주문 그래프(leftJoinAndSelect)를 다시 조회한다 — 경로 분기의 양성 신호로 쓴다.
    const graphQuery = { used: false };
    sut.orderRepository = {
      createQueryBuilder: jest.fn(() => {
        const b: any = {
          setLock: () => b,
          leftJoinAndSelect: () => {
            graphQuery.used = true;
            return b;
          },
          where: () => b,
          getOne: async () => order,
        };
        return b;
      }),
      save: jest.fn(async () => order),
      manager: { findOne: jest.fn(async () => ({ ...allocation })) },
    };

    const company = {
      id: 10,
      balance: 50000,
      businessNumber: '999-99-99999',
      balanceManagementType: over.balanceManagementType ?? 'COMPANY',
    } as any;
    const billingUser = {
      id: 5,
      allSettleAmount: 80000,
      personEmail: 'ceo@example.com',
      personName: '홍길동',
      authority: over.authority ?? 'CORPORATE_ADMIN',
      company,
    } as any;
    sut.userRepository = {
      findOneOrFail: jest.fn(async () => billingUser),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    sut.userCompanyRepository = { save: jest.fn(async () => company) };
    sut.orderCancelNotificationService = {
      notifyDirectOrderCancel: jest.fn(),
      notifyDirectOrderPartialCancel: jest.fn(),
    };

    // 잔여 발송건 카운트용 빌더.
    // ★ andWhere 인자를 캡처한다. getCount 만 스텁하면 조건을 반전시켜도(= vs !=) 전부 통과해
    //   "잔여 판정" 테스트가 아무것도 지키지 못한다 — 실제로 뮤테이션으로 확인된 공백이었다.
    const remainingConditions: Array<[string, any]> = [];
    sut.orderDeliveryRepository = {
      createQueryBuilder: jest.fn(() => {
        const b: any = {
          innerJoin: () => b,
          where: () => b,
          andWhere: (condition: string, params: any) => {
            remainingConditions.push([condition, params]);
            return b;
          },
          getCount: async () => remaining,
        };
        return b;
      }),
    };

    sut.walletManagedPredicate = { isWalletManaged: jest.fn(async () => over.isWalletManaged ?? true) };
    // 실제 RefundPoolService 는 allocation 의 누적 복구액을 올린다 — 재원별 복구액을 그 차이로 읽으므로
    // 목도 같은 부수효과를 내야 레거시 미러 검증이 의미를 갖는다.
    sut.refundPoolService = {
      refund: jest.fn(async () => {
        if (over.alreadyRefunded) {
          return { alreadyRefunded: true, ledgerIds: ['l-1'], totalRefundedAmount: 0 };
        }
        allocation.depositRestoredAmount += refundBreakdown.deposit;
        allocation.creditUsedRestoredAmount += refundBreakdown.credit;
        allocation.creditExcessRestoredAmount += refundBreakdown.excess;
        return {
          alreadyRefunded: false,
          ledgerIds: ['l-1'],
          totalRefundedAmount: refundBreakdown.deposit + refundBreakdown.credit + refundBreakdown.excess,
        };
      }),
    };
    sut.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };

    sut.findCancelableDeliveryIds = jest.fn(async () => cancelableIds);
    sut.cancelDeliveriesIfStillWaiting = jest.fn(async () => undefined);

    // 잔여분 정산금액 재계산용(approach B). 정산수정과 동일하게 getOrderProductsForSettlementAmount 를
    // 재조회해 calculateOrderSettlementAmount 로 덮는다. 기본은 빈 목록(=0), 테스트가 필요 시 주입.
    const survivingMappings = over.survivingMappings ?? [];
    sut.getOrderProductsForSettlementAmount = jest.fn(async () => survivingMappings);

    return { sut, order, remainingConditions, graphQuery, billingUser, company, survivingMappings };
  };

  const call = (sut: any, deliveryIds: number[]) =>
    sut.deliveryCancel({ id: 1 }, { id: ORDER_ID, cancelReason: '고객 요청', deliveryIds });

  describe('경로 분기', () => {
    it('deliveryIds 를 주면 부분취소 경로로 간다', async () => {
      const { sut } = buildSut();

      await call(sut, CANCELABLE);

      expect(sut.cancelDeliveriesIfStillWaiting).toHaveBeenCalledWith(
        ORDER_ID,
        CANCELABLE,
        '고객 요청',
        expect.any(Date),
      );
    });

    // 기존 프론트는 이 필드를 보내지 않는다 — 종전 전체취소가 그대로 동작해야 배포 창이 생기지 않는다.
    //
    // ★ 이 fixture 는 전체취소 경로의 의존성을 다 갖추지 않아 중간에 던진다. 그래서 예외를 삼키되,
    //   "안 갔다" 는 음성 신호만 보면 첫 줄에서 터져도 통과해버린다 — 전체취소 경로만 하는 일
    //   (주문 그래프 재조회)이 실제로 일어났는지 **양성 신호**로 확인한다.
    it('deliveryIds 가 없으면 전체취소 경로로 간다', async () => {
      const { sut, graphQuery } = buildSut();

      await sut.deliveryCancel({ id: 1 }, { id: ORDER_ID, cancelReason: 'r' }).catch(() => undefined);

      expect(graphQuery.used).toBe(true);
      expect(sut.findCancelableDeliveryIds).not.toHaveBeenCalled();
      expect(sut.cancelDeliveriesIfStillWaiting).not.toHaveBeenCalled();
    });
  });

  describe('거부 조건', () => {
    it.each([
      ['주문완료', IOrderStatus.DELIVERY_REQUEST],
      ['검토완료', IOrderStatus.REVIEW_COMPLETE],
      ['발송완료', IOrderStatus.DELIVERY_COMPLETE],
    ])('발송확정 상태가 아니면(%s) 거부한다', async (_caseName, status) => {
      const { sut } = buildSut({ status });

      await expect(call(sut, CANCELABLE)).rejects.toBeInstanceOf(BadRequestException);
      expect(sut.cancelDeliveriesIfStillWaiting).not.toHaveBeenCalled();
    });

    // SSG 는 행사잔액 차감 이력이 주문 단위로 뭉쳐 있어 발송건 몫을 역산할 근거가 없다.
    // 근거 없이 안분하면 행사잔액이 부풀고, 그쪽은 상한 검증이 없어 되돌리기 어렵다.
    it('SSG 주문은 아직 거부한다', async () => {
      const { sut } = buildSut({ type: IOrderType.SSG });

      await expect(call(sut, CANCELABLE)).rejects.toThrow(/SSG/);
      expect(sut.refundPoolService.refund).not.toHaveBeenCalled();
    });

    it('지갑(allocation) 이 없는 주문은 거부한다 — 발송건 몫 환불의 근거가 없다', async () => {
      const { sut } = buildSut({ isWalletManaged: false });

      await expect(call(sut, CANCELABLE)).rejects.toBeInstanceOf(BadRequestException);
      expect(sut.refundPoolService.refund).not.toHaveBeenCalled();
    });

    // ★ 부분 수용(가능한 것만 취소)하지 않는다. 요청자는 N건을 취소했다고 믿는데 M건만 취소되고
    //   환불도 M건분이면, 차이를 응답으로 알려줘도 이미 일부가 커밋된 뒤다.
    it('취소 불가한 id 가 하나라도 섞이면 전량 거부한다', async () => {
      const { sut } = buildSut();

      await expect(call(sut, [...CANCELABLE, ALREADY_SENT])).rejects.toThrow(String(ALREADY_SENT));
      expect(sut.cancelDeliveriesIfStillWaiting).not.toHaveBeenCalled();
      expect(sut.refundPoolService.refund).not.toHaveBeenCalled();
    });

    it('다른 주문의 발송건 id 도 같은 이유로 거부된다 (판정이 주문 범위로 한정돼 있다)', async () => {
      const { sut } = buildSut();

      await expect(call(sut, [99999])).rejects.toBeInstanceOf(BadRequestException);
      expect(sut.refundPoolService.refund).not.toHaveBeenCalled();
    });
  });

  describe('환불', () => {
    it('취소한 발송건만 환불 대상으로 넘긴다', async () => {
      const { sut } = buildSut();

      await call(sut, CANCELABLE);

      expect(sut.refundPoolService.refund).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: ORDER_ID,
          // CS 폐기환불(DISCARD_REFUND)과 구분해야 원장에서 취소 사유를 추적할 수 있다.
          eventType: OrderPaymentRefundEventType.CANCEL,
          targetDeliveryIds: CANCELABLE,
        }),
        expect.anything(),
      );
    });

    // ★ 저장 컬럼이 varchar(120) 이고 RefundPoolService 가 prefix 뒤에 `:line:{id}:point_skipped_expired`
    //   (최대 27자)를 덧붙인다. id 를 나열하던 예전 방식은 발송건 9건부터 이 상한을 넘겨
    //   strict 모드에서 Data too long 으로 트랜잭션이 통째로 롤백됐다.
    it('멱등키 prefix 는 취소 건수와 무관하게 길이가 고정된다 — varchar(120) 초과 방지', async () => {
      const many = Array.from({ length: 500 }, (_, i) => 9000000 + i);
      const { sut } = buildSut({ cancelableIds: many });

      await call(sut, many);

      const { idempotencyKeyPrefix } = sut.refundPoolService.refund.mock.calls[0][0];
      // prefix + RefundPoolService 최장 접미사가 120 을 넘지 않아야 한다.
      expect(idempotencyKeyPrefix.length + ':line:99999999:point_skipped_expired'.length).toBeLessThanOrEqual(120);
    });

    it('같은 발송건 집합은 순서가 달라도 같은 멱등키를 만든다 — 재시도가 중복 환불이 되지 않는다', async () => {
      const { sut: a } = buildSut();
      const { sut: b } = buildSut();

      await call(a, [9005, 9003, 9004]);
      await call(b, [9003, 9004, 9005]);

      expect(a.refundPoolService.refund.mock.calls[0][0].idempotencyKeyPrefix).toBe(
        b.refundPoolService.refund.mock.calls[0][0].idempotencyKeyPrefix,
      );
    });

    // 멱등 hit 이면 원장만 재사용되고 실제 잔액은 움직이지 않는다. 성공으로 응답하면
    // "취소됐고 환불됐다" 고 알리면서 0원이 나간다.
    it('환불이 멱등 hit 이면 성공으로 넘기지 않고 던진다 (취소도 롤백)', async () => {
      const { sut } = buildSut({ alreadyRefunded: true });

      await expect(call(sut, CANCELABLE)).rejects.toBeInstanceOf(ConflictException);
      expect(sut.logger.error).toHaveBeenCalledWith(expect.stringContaining('DELIVERY_CANCEL_REFUND_NOOP'));
    });

    it('취소를 먼저 하고 환불한다 — 취소가 실패하면 환불하지 않는다', async () => {
      const { sut } = buildSut();
      sut.cancelDeliveriesIfStillWaiting = jest.fn(async () => {
        throw new Error('경합');
      });

      await expect(call(sut, CANCELABLE)).rejects.toThrow('경합');
      expect(sut.refundPoolService.refund).not.toHaveBeenCalled();
    });

    it('중복 id 를 접어서 넘긴다 — 중복분까지 환불하지 않는다', async () => {
      const { sut } = buildSut();

      await call(sut, [9003, 9003, 9004]);

      expect(sut.refundPoolService.refund).toHaveBeenCalledWith(
        expect.objectContaining({ targetDeliveryIds: [9003, 9004] }),
        expect.anything(),
      );
    });
  });

  describe('주문 상태', () => {
    // 잔여분이 살아 있으면 DELIVERY_CONFIRMED 를 유지해야 배치가 정상 발송하고,
    // 전건 터미널이 됐을 때 완료·정산으로 넘어간다.
    it('잔여 발송건이 있으면 주문 상태를 내리지 않는다', async () => {
      const { sut, order } = buildSut({ remainingAfterCancel: 2 });

      await call(sut, CANCELABLE);

      expect(order.status).toBe(IOrderStatus.DELIVERY_CONFIRMED);
      // 주문 단위 취소 필드는 건드리지 않는다 — 주문 자체는 취소된 게 아니다.
      // (settleAmount 는 환불액만큼 줄어들므로 save 자체는 일어난다.)
      expect(order.cancelReason).toBeNull();
      expect(order.canceledAt).toBeNull();
    });

    it('전건이 취소되면 주문도 취소로 내린다', async () => {
      const { sut, order } = buildSut({ remainingAfterCancel: 0 });

      await call(sut, CANCELABLE);

      expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
      expect(order.cancelReason).toBe('고객 요청');
      expect(order.canceledAt).toBeInstanceOf(Date);
      expect(sut.orderRepository.save).toHaveBeenCalled();
    });

    // ★ 조건을 직접 본다. 이 판정이 뒤집히면(!= → =) 잔여분이 남아 있는데도 remaining=0 이 되어
    //   주문이 DELIVERY_CANCEL 로 내려가고, 아직 발송해야 할 예약건이 통째로 죽는다.
    it('잔여 판정은 CANCEL "이 아닌" 발송건을 센다 (조건 반전 방지)', async () => {
      const { sut, remainingConditions } = buildSut();

      await call(sut, CANCELABLE);

      expect(remainingConditions).toContainEqual([
        'od.status != :canceled',
        { canceled: IOrderDeliveryStatus.CANCEL },
      ]);
    });
  });

  // ★ 정산정보 입력/수정은 `difference = order.settleAmount - 재계산금액` 만큼 잔액을 조정한다.
  //   재계산 쪽(buildSettlementDisplayLines)이 취소분을 빼므로, settleAmount 를 원액으로 두면
  //   이미 환불한 몫이 한 번 더 지급된다. 부분취소가 "발송확정 + 취소된 발송건" 조합의 첫 생산자다.
  describe('주문 정산금액', () => {
    // 균일 매핑: 원 수량 3, 단가 35000, 1건 취소(status=CANCEL) → 잔여 2건 → 재계산 70000.
    const uniformSurviving = () => [
      {
        amount: 3,
        fee: null,
        priceAdjustment: null,
        product: { price: 35000 },
        orderDeliveries: [
          { id: 9003, status: IOrderDeliveryStatus.CANCEL, settleFee: null, couponStatus: null, replacedFromId: null },
          { id: 9004, status: IOrderDeliveryStatus.WAIT, settleFee: null, couponStatus: null, replacedFromId: null },
          { id: 9005, status: IOrderDeliveryStatus.WAIT, settleFee: null, couponStatus: null, replacedFromId: null },
        ],
      },
    ];

    // ★ 핵심: settleAmount 를 "환불 실지급액 차감" 이 아니라 정산수정과 동일한 함수
    //   (calculateOrderSettlementAmount) 로 재계산해 덮는다. 그래야 카드할증+포인트 병용에서
    //   할증 base 불일치(payable vs gross)로 인한 잔차 없이 difference 가 정확히 0 이 된다.
    it('정산금액을 취소 반영 후 재계산 값으로 맞춘다 (환불액 차감이 아님)', async () => {
      const survivingMappings = uniformSurviving();
      const { sut, order } = buildSut({ settleAmount: 100000, survivingMappings });

      await call(sut, CANCELABLE);

      const expected = calculateOrderSettlementAmount(
        { cardSurchargeApplied: false, orderProductMappings: survivingMappings as any },
        false,
      );
      expect(order.settleAmount).toBe(expected);
      expect(expected).toBe(70000); // 균일 2건 × 35000
      expect(sut.getOrderProductsForSettlementAmount).toHaveBeenCalledWith(ORDER_ID);
      expect(sut.orderRepository.save).toHaveBeenCalled();
    });

    it('전건 취소면 전체취소와 같은 종단 상태를 만든다', async () => {
      const { sut, order } = buildSut({ remainingAfterCancel: 0 });

      await call(sut, CANCELABLE);

      expect(order.settleAmount).toBe(0);
      expect(order.isSettleBalance).toBe(false);
      expect(order.isCreditExcess).toBe(false);
      // 전건 취소는 재계산하지 않는다(0 대입) — 잔여분 재조회를 하지 않아야 한다.
      expect(sut.getOrderProductsForSettlementAmount).not.toHaveBeenCalled();
    });
  });

  // 지갑 잔액은 RefundPoolService 가 맞추지만 레거시 컬럼은 건드리지 않는다. 전체취소·외부API취소는
  // 이 역복원을 하는데 부분취소만 빠져 있으면 고객사 화면과 정산 화면의 잔액이 어긋난다.
  describe('레거시 미러 역복원', () => {
    it('예치금 복구분은 회사 balance 에 되돌린다 (COMPANY 모드)', async () => {
      const { sut, company } = buildSut({ refundBreakdown: { deposit: 30000, credit: 0, excess: 0 } });

      await call(sut, CANCELABLE);

      expect(company.balance).toBe(80000);
      expect(sut.userCompanyRepository.save).toHaveBeenCalled();
    });

    it('여신·신용초과 복구분은 allSettleAmount 에서 뺀다', async () => {
      const { sut, billingUser } = buildSut({ refundBreakdown: { deposit: 0, credit: 20000, excess: 5000 } });

      await call(sut, CANCELABLE);

      expect(billingUser.allSettleAmount).toBe(55000);
      expect(sut.userRepository.update).toHaveBeenCalledWith({ id: 5 }, { allSettleAmount: 55000 });
    });

    it('PERSONAL 모드면 회사 balance 를 건드리지 않는다', async () => {
      const { sut, company } = buildSut({
        balanceManagementType: 'PERSONAL',
        refundBreakdown: { deposit: 30000, credit: 0, excess: 0 },
      });

      await call(sut, CANCELABLE);

      expect(company.balance).toBe(50000);
      expect(sut.userCompanyRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('고객사 통지', () => {
    // ★ 전체취소 문안("주문이 취소되었습니다")을 재사용하면, 잔여분이 예정대로 나가는데도
    //   고객에게 주문 전체가 취소됐다고 알리게 된다.
    it('DIRECT 고객사 주문은 부분취소 전용 문안으로 통지한다', async () => {
      const { sut, order, billingUser } = buildSut({ remainingAfterCancel: 2 });

      await call(sut, CANCELABLE);

      expect(sut.orderCancelNotificationService.notifyDirectOrderPartialCancel).toHaveBeenCalledWith(
        order,
        billingUser,
        expect.objectContaining({ canceledCount: 3, remainingCount: 2, cancelReason: '고객 요청' }),
      );
      expect(sut.orderCancelNotificationService.notifyDirectOrderCancel).not.toHaveBeenCalled();
    });

    it('통지 대상이 아니면 발송하지 않는다', async () => {
      const { sut } = buildSut({ authority: 'ADMIN' });

      await call(sut, CANCELABLE);

      expect(sut.orderCancelNotificationService.notifyDirectOrderPartialCancel).not.toHaveBeenCalled();
    });
  });

  it('주문이 없으면 거부한다', async () => {
    const { sut } = buildSut();
    sut.orderRepository.createQueryBuilder = jest.fn(() => {
      const b: any = { setLock: () => b, where: () => b, getOne: async () => null };
      return b;
    });

    await expect(call(sut, CANCELABLE)).rejects.toBeInstanceOf(BadRequestException);
  });

});
