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

  /**
   * 잔여분 재계산에 쓰이는 매핑 fixture.
   * 균일 매핑: 원 수량 3, 단가 35000, 1건 취소(status=CANCEL) → 잔여 2건 → 재계산 70000.
   *
   * ★ 이 값을 buildSut 의 기본값으로 둔다. 예전 기본값은 빈 배열(=재계산 0원)이었는데, 그건
   *   "잔여 발송건이 있는데 정산금액은 0" 이라는 **불가능한 상태**를 기본으로 깔아 둔 것이었다.
   *   프로덕션은 이제 그 조합을 fail-closed 로 막으므로(무·과소환불 차단) fixture 도 현실을 따른다.
   */
  const uniformSurvivingMappings = () => [
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
      cardSurchargeApplied?: boolean;
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
      cardSurchargeApplied: over.cardSurchargeApplied ?? false,
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
    // 레거시 미러 복원은 값을 되쓰지 않고 DB 증감식(UPDATE ... SET x = x ± :n)으로 나간다.
    // set() 에 넘긴 식과 파라미터를 캡처해, read-modify-write 로 되돌아가면 잡히게 한다.
    type CapturedUpdate = { set: Record<string, () => string>; params: unknown; where: unknown };
    const makeUpdateBuilder = (sink: CapturedUpdate[]) => () => {
      const captured = { set: {}, params: null, where: null } as unknown as CapturedUpdate;
      const b: any = {
        update: () => b,
        set: (value: Record<string, () => string>) => {
          captured.set = value;
          return b;
        },
        where: (_condition: string, params: unknown) => {
          captured.where = params;
          return b;
        },
        setParameters: (params: unknown) => {
          captured.params = params;
          return b;
        },
        execute: async () => {
          sink.push(captured);
          return { affected: 1 };
        },
      };
      return b;
    };
    const userUpdates: CapturedUpdate[] = [];
    const companyUpdates: CapturedUpdate[] = [];

    sut.userRepository = {
      findOneOrFail: jest.fn(async () => billingUser),
      update: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn(makeUpdateBuilder(userUpdates)),
    };
    sut.userCompanyRepository = {
      save: jest.fn(async () => company),
      createQueryBuilder: jest.fn(makeUpdateBuilder(companyUpdates)),
    };
    // 전건 취소 시 전체취소와 같은 표현으로 allocation 을 닫는다(released_at).
    sut.orderConfirmationReleaseService = {
      releaseConfirmation: jest.fn(async () => ({
        alreadyReleased: false,
        walletTransactionIds: [],
        rolledBackAttemptIds: [],
      })),
    };
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
      // 원장은 라인당 1개 → 정상 흐름은 요청 건수만큼 반환(커버리지 가드 통과).
      refund: jest.fn(async (input: any) => {
        const ledgerIds = (input.targetDeliveryIds as number[]).map((id) => `l-${id}`);
        if (over.alreadyRefunded) {
          return { alreadyRefunded: true, ledgerIds, totalRefundedAmount: 0 };
        }
        allocation.depositRestoredAmount += refundBreakdown.deposit;
        allocation.creditUsedRestoredAmount += refundBreakdown.credit;
        allocation.creditExcessRestoredAmount += refundBreakdown.excess;
        return {
          alreadyRefunded: false,
          ledgerIds,
          totalRefundedAmount: refundBreakdown.deposit + refundBreakdown.credit + refundBreakdown.excess,
        };
      }),
    };
    sut.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };

    sut.findCancelableDeliveryIds = jest.fn(async () => cancelableIds);
    sut.cancelDeliveriesIfStillWaiting = jest.fn(async () => undefined);

    // 잔여분 정산금액 재계산용(approach B). 부분취소 전용 로더로 재조회해
    // calculateOrderSettlementAmount 로 덮는다. 기본은 잔여 2건과 아귀가 맞는 균일 매핑(=70000).
    const survivingMappings = over.survivingMappings ?? uniformSurvivingMappings();
    sut.getOrderProductsForCancelSettlement = jest.fn(async () => survivingMappings);

    return {
      sut,
      order,
      remainingConditions,
      graphQuery,
      billingUser,
      company,
      survivingMappings,
      userUpdates,
      companyUpdates,
    };
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
    const uniformSurviving = uniformSurvivingMappings;

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
      expect(sut.getOrderProductsForCancelSettlement).toHaveBeenCalledWith(ORDER_ID);
      expect(sut.orderRepository.save).toHaveBeenCalled();
    });

    // ★ 재계산은 order.cardSurchargeApplied 를 그대로 넘겨 할증을 얹는다. 이 축(cardSurchargeApplied=true)이
    //   부분취소 통합 스펙에서 한 번도 실행되지 않아, 위 주석이 방어 대상이라 선언한 '카드할증+포인트
    //   병용 잔차 0' 의 할증 분기가 미검증이었다(pr-test M-1). 여기서 재계산에 할증이 실제 반영됨을 고정.
    it('재계산에 카드할증이 반영된다 (cardSurchargeApplied=true) — M-1', async () => {
      const survivingMappings = uniformSurviving();
      const { sut, order } = buildSut({ settleAmount: 100000, survivingMappings, cardSurchargeApplied: true });

      await call(sut, CANCELABLE);

      const expected = calculateOrderSettlementAmount(
        { cardSurchargeApplied: true, orderProductMappings: survivingMappings as any },
        true,
      );
      expect(order.settleAmount).toBe(expected);
      // 할증이 실제로 얹혔는지 — 비할증 재계산(70000)보다 커야 한다(값이 무할증과 갈린다).
      expect(expected).toBeGreaterThan(70000);
    });

    it('전건 취소면 전체취소와 같은 종단 상태를 만든다', async () => {
      const { sut, order } = buildSut({ remainingAfterCancel: 0 });

      await call(sut, CANCELABLE);

      expect(order.settleAmount).toBe(0);
      expect(order.isSettleBalance).toBe(false);
      expect(order.isCreditExcess).toBe(false);
      // 전건 취소는 재계산하지 않는다(0 대입) — 잔여분 재조회를 하지 않아야 한다.
      expect(sut.getOrderProductsForCancelSettlement).not.toHaveBeenCalled();
    });

    // ── 소프트삭제된 상품이 섞인 주문 (리뷰 HIGH) ───────────────────────────────────
    //
    // 정산수정과 공유하는 로더는 product 를 innerJoin 이라, 주문 이후 상품이 소프트삭제되면
    // 그 매핑 행이 결과에서 사라진다. 그대로 재계산하면 settleAmount 가 과소(전부 삭제면 0)로
    // 저장되고, 이후 **전체취소가 그 값을 환불액으로 읽어**(신흐름 refundAmount=order.settleAmount)
    // "취소는 되고 환불은 0원" 이 된다. 그래서 부분취소는 전용 로더(leftJoin)로 매핑 행을 남기고
    // 주문 시점 스냅샷 단가로 재계산한다.
    it('상품이 삭제돼도 스냅샷 단가로 재계산한다 (product 없음 → snapshotProductPrice)', async () => {
      // leftJoin 이므로 매핑은 남고 product 만 null 이다. 단가는 스냅샷에서 온다.
      const deletedProductMappings = [
        {
          amount: 3,
          fee: null,
          priceAdjustment: null,
          product: null, // 소프트삭제 → 조인 결과 없음
          snapshotProductPrice: 35000, // 주문 시점 박제 단가
          orderDeliveries: [
            { id: 9003, status: IOrderDeliveryStatus.CANCEL, settleFee: null, couponStatus: null, replacedFromId: null },
            { id: 9004, status: IOrderDeliveryStatus.WAIT, settleFee: null, couponStatus: null, replacedFromId: null },
            { id: 9005, status: IOrderDeliveryStatus.WAIT, settleFee: null, couponStatus: null, replacedFromId: null },
          ],
        },
      ];
      const { sut, order } = buildSut({ settleAmount: 100000, survivingMappings: deletedProductMappings });

      await call(sut, CANCELABLE);

      // 0 이 아니라 잔여 2건 × 35000 이어야 한다. 0 이면 이후 전체취소가 환불을 통째로 건너뛴다.
      expect(order.settleAmount).toBe(70000);
    });

    // 스냅샷도 없고 상품도 삭제된 옛 주문은 단가를 복원할 근거 자체가 없다.
    // 조용히 0 을 저장하면 이후 전체취소가 0 원을 환불한다 — 돈이 걸린 침묵이라 던져서 롤백한다.
    it('단가 복원 근거가 없으면(스냅샷·상품 모두 부재) 던진다 (조용한 0 저장 차단)', async () => {
      const unresolvableMappings = [
        {
          amount: 3,
          fee: null,
          priceAdjustment: null,
          product: null, // 삭제됨
          snapshotProductPrice: null, // 스냅샷 이전 주문
          orderDeliveries: [
            { id: 9003, status: IOrderDeliveryStatus.CANCEL, settleFee: null, couponStatus: null, replacedFromId: null },
            { id: 9004, status: IOrderDeliveryStatus.WAIT, settleFee: null, couponStatus: null, replacedFromId: null },
          ],
        },
      ];
      const { sut, order } = buildSut({ settleAmount: 100000, survivingMappings: unresolvableMappings });

      await expect(call(sut, CANCELABLE)).rejects.toThrow(/정산금액을 계산하지 못해/);
      // 롤백 대상이므로 0 이 대입된 채로 남지 않아야 한다(원본 유지).
      expect(order.settleAmount).toBe(100000);
    });

    // ★ 위 가드를 "재계산 결과가 0" 으로 판정하면 안 되는 이유.
    //   정당한 0원 정산 주문(무료 프로모션·전액할인)이 같은 값을 낸다. 그걸 막으면 그 주문은
    //   전체취소로 밀려나고, 전체취소는 refundAmount(0) > 0 단락평가로 wallet 경로를 건너뛰어
    //   allocation.released_at 이 NULL 로 남는다 — 이 브랜치가 막으려던 바로 그 drift 다.
    //   그래서 판정은 "값이 0인가" 가 아니라 "단가 복원 근거가 없는가" 여야 한다.
    it('정당한 0원 정산 주문은 막지 않는다 (스냅샷이 0 이면 근거가 있는 값이다)', async () => {
      const freeMappings = [
        {
          amount: 3,
          fee: null,
          priceAdjustment: null,
          product: null, // 상품은 삭제됐지만
          snapshotProductPrice: 0, // 주문 시점 단가가 0 원으로 박제돼 있다 = 근거 있음
          orderDeliveries: [
            { id: 9003, status: IOrderDeliveryStatus.CANCEL, settleFee: null, couponStatus: null, replacedFromId: null },
            { id: 9004, status: IOrderDeliveryStatus.WAIT, settleFee: null, couponStatus: null, replacedFromId: null },
          ],
        },
      ];
      const { sut, order } = buildSut({ settleAmount: 0, survivingMappings: freeMappings });

      await call(sut, CANCELABLE);

      expect(order.settleAmount).toBe(0);
    });
  });

  // 지갑 잔액은 RefundPoolService 가 맞추지만 레거시 컬럼은 건드리지 않는다. 전체취소·외부API취소는
  // 이 역복원을 하는데 부분취소만 빠져 있으면 고객사 화면과 정산 화면의 잔액이 어긋난다.
  describe('레거시 미러 역복원', () => {
    // ★ balance / all_settle_amount 는 회사·유저 단위 공유 자원이라 이 주문의 락으로 보호되지 않는다.
    //   읽은 값에 델타를 더해 되쓰면(read-modify-write) 같은 고객사의 다른 주문이 동시에 취소될 때
    //   갱신 하나가 통째로 유실된다 — 환불했는데 잔액에 반영되지 않는다. 그래서 증감식을 DB 로 넘긴다.
    it('예치금 복구분은 회사 balance 를 DB 증감식으로 올린다 (COMPANY 모드)', async () => {
      const { sut, company, companyUpdates } = buildSut({
        refundBreakdown: { deposit: 30000, credit: 0, excess: 0 },
      });

      await call(sut, CANCELABLE);

      expect(companyUpdates).toHaveLength(1);
      expect(companyUpdates[0].set.balance()).toBe('balance + :depositRefunded');
      expect(companyUpdates[0].params).toEqual({ depositRefunded: 30000 });
      expect(companyUpdates[0].where).toEqual({ id: 10 });
      // 엔티티 값을 고쳐 되쓰지 않는다 — 고쳤다면 lost update 방식으로 되돌아간 것이다.
      expect(company.balance).toBe(50000);
      expect(sut.userCompanyRepository.save).not.toHaveBeenCalled();
    });

    it('여신·신용초과 복구분은 all_settle_amount 를 DB 증감식으로 내린다', async () => {
      const { sut, billingUser, userUpdates } = buildSut({
        refundBreakdown: { deposit: 0, credit: 20000, excess: 5000 },
      });

      await call(sut, CANCELABLE);

      expect(userUpdates).toHaveLength(1);
      expect(userUpdates[0].set.allSettleAmount()).toBe('all_settle_amount - :creditReturned');
      // 여신 + 신용초과를 합쳐 한 번에 내린다.
      expect(userUpdates[0].params).toEqual({ creditReturned: 25000 });
      expect(userUpdates[0].where).toEqual({ id: 5 });
      expect(billingUser.allSettleAmount).toBe(80000);
    });

    it('PERSONAL 모드면 회사 balance 를 건드리지 않는다', async () => {
      const { sut, company, companyUpdates } = buildSut({
        balanceManagementType: 'PERSONAL',
        refundBreakdown: { deposit: 30000, credit: 0, excess: 0 },
      });

      await call(sut, CANCELABLE);

      expect(companyUpdates).toHaveLength(0);
      expect(company.balance).toBe(50000);
    });
  });

  // 돈이 오간 엔드포인트가 void 를 돌려주면 클라이언트는 "무엇이 취소됐고 얼마가 돌아갔는지" 를
  // 대사할 방법이 없다(서버 로그에만 남음). 응답 필드가 사라지면 여기서 깨진다.
  describe('취소 결과 응답', () => {
    it('취소된 id·환불액·잔여 건수를 돌려준다', async () => {
      const { sut } = buildSut({
        remainingAfterCancel: 2,
        refundBreakdown: { deposit: 30000, credit: 20000, excess: 5000 },
      });

      const result = await call(sut, CANCELABLE);

      expect(result).toEqual({
        canceledIds: CANCELABLE,
        refundedAmount: 55000, // 예치금 + 여신 + 신용초과
        remaining: 2,
      });
    });

    // 전량 거부 정책상 부분 성공이 없으므로 canceledIds 는 요청 집합과 같다.
    // 다만 중복은 접고 정렬한 "실제 처리 대상" 이어야 클라이언트가 자기 요청과 대조할 수 있다.
    it('canceledIds 는 중복을 접고 정렬한 실제 처리 대상이다', async () => {
      const { sut } = buildSut();

      const result = await call(sut, [9005, 9003, 9004, 9003]);

      expect(result.canceledIds).toEqual([9003, 9004, 9005]);
    });
  });

  // 같은 종단 사건(대기건이 하나도 안 남음)이 요청 형태에 따라 두 가지 wallet 표현으로 갈리면
  // 사후 스윕·정산이 둘을 다르게 본다. isWalletManaged 는 released_at IS NULL 로 판정하므로,
  // 전량 부분취소가 released_at 을 안 닫으면 "주문은 취소됐는데 지갑은 점유 중" 이 남는다.
  describe('allocation 종단 처리', () => {
    it('전건 취소면 전체취소와 같이 allocation 을 닫는다 (released_at)', async () => {
      const { sut } = buildSut({ remainingAfterCancel: 0 });

      await call(sut, CANCELABLE);

      expect(sut.orderConfirmationReleaseService.releaseConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID, failedDeliveryIds: null }),
        expect.anything(),
      );
    });

    it('잔여가 있으면 allocation 을 닫지 않는다 (잔여분이 아직 지갑 점유 중)', async () => {
      const { sut } = buildSut({ remainingAfterCancel: 2 });

      await call(sut, CANCELABLE);

      expect(sut.orderConfirmationReleaseService.releaseConfirmation).not.toHaveBeenCalled();
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

    // ★ 잔여 0(대기 전량 취소)이면 주문이 DELIVERY_CANCEL 로 내려가 사실상 전체취소다. 이때 부분취소
    //   문안("일부 취소, 남은 0건")을 보내면 모순된 안내가 나가므로 전체취소 문안으로 보낸다.
    it('전건 소진(remaining=0)이면 전체취소 문안으로 통지한다 (부분취소 문안 아님)', async () => {
      const { sut, order } = buildSut({ remainingAfterCancel: 0 });

      await call(sut, CANCELABLE);

      expect(sut.orderCancelNotificationService.notifyDirectOrderCancel).toHaveBeenCalledWith(order, expect.anything());
      expect(sut.orderCancelNotificationService.notifyDirectOrderPartialCancel).not.toHaveBeenCalled();
    });
  });

  // ★ cancelDeliveriesIfStillWaiting 은 요청 전부를 CANCEL 로 바꾸지만, 환불은 allocation_line 이 있는
  //   발송건만 한다(원장 1개/라인). 원장 수 != 요청 수면 일부가 미환불(고객 계속 청구)인데 로그도 없이
  //   200 이 나가므로, 커버리지 불일치를 롤백으로 막는다.
  describe('환불 커버리지', () => {
    it('환불 원장 수가 요청 건수보다 적으면(라인 누락) 롤백한다', async () => {
      const { sut } = buildSut();
      // refund 목이 요청 3건인데 원장 2개만 반환 → 1건 미환불.
      sut.refundPoolService.refund = jest.fn(async () => ({
        alreadyRefunded: false,
        ledgerIds: ['l-1', 'l-2'],
        totalRefundedAmount: 20000,
      }));

      await expect(call(sut, CANCELABLE)).rejects.toBeInstanceOf(ConflictException);
      expect(sut.logger.error).toHaveBeenCalledWith(expect.stringContaining('DELIVERY_CANCEL_REFUND_COVERAGE'));
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
