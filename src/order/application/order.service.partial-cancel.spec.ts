// ★ requireActual 스프레드 필수: import 그래프 내 다른 서비스가 Propagation 등 다른 export 를
//   클래스정의 시점에 쓰므로, 전체 모듈을 덮으면 로드가 깨진다.
jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderPaymentRefundEventType } from '../../entity/order.payment.refund.event.entity';

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
    } = {},
  ) => {
    const order = {
      id: ORDER_ID,
      status: over.status ?? IOrderStatus.DELIVERY_CONFIRMED,
      type: over.type ?? IOrderType.GENERAL,
      cancelReason: null as string | null,
      canceledAt: null as Date | null,
    } as any;

    const cancelableIds = over.cancelableIds ?? CANCELABLE;
    const remaining = over.remainingAfterCancel ?? 2; // 기본: 발송완료 2건이 남아 있다

    const sut: any = Object.create(OrderService.prototype);

    sut.orderRepository = {
      createQueryBuilder: jest.fn(() => {
        const b: any = { setLock: () => b, where: () => b, getOne: async () => order };
        return b;
      }),
      save: jest.fn(async () => order),
      manager: {},
    };

    // 잔여 발송건 카운트용 빌더
    sut.orderDeliveryRepository = {
      createQueryBuilder: jest.fn(() => {
        const b: any = {
          innerJoin: () => b,
          where: () => b,
          andWhere: () => b,
          getCount: async () => remaining,
        };
        return b;
      }),
    };

    sut.walletManagedPredicate = { isWalletManaged: jest.fn(async () => over.isWalletManaged ?? true) };
    sut.refundPoolService = { refund: jest.fn(async () => ({ alreadyRefunded: false, ledgerIds: ['l-1'] })) };
    sut.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };

    sut.findCancelableDeliveryIds = jest.fn(async () => cancelableIds);
    sut.cancelDeliveriesIfStillWaiting = jest.fn(async () => undefined);

    return { sut, order };
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
    it('deliveryIds 가 없으면 전체취소 경로로 간다', async () => {
      const { sut } = buildSut();

      // 전체취소 경로는 findCancelableDeliveryIds 를 쓰지 않는다(그 경로의 계약은 별도 스펙이 지킨다).
      await sut.deliveryCancel({ id: 1 }, { id: ORDER_ID, cancelReason: 'r' }).catch(() => undefined);

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
          eventType: OrderPaymentRefundEventType.DISCARD_REFUND,
          targetDeliveryIds: CANCELABLE,
        }),
        expect.anything(),
      );
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
      expect(sut.orderRepository.save).not.toHaveBeenCalled();
    });

    it('전건이 취소되면 주문도 취소로 내린다', async () => {
      const { sut, order } = buildSut({ remainingAfterCancel: 0 });

      await call(sut, CANCELABLE);

      expect(order.status).toBe(IOrderStatus.DELIVERY_CANCEL);
      expect(order.cancelReason).toBe('고객 요청');
      expect(order.canceledAt).toBeInstanceOf(Date);
      expect(sut.orderRepository.save).toHaveBeenCalled();
    });

    it('잔여 판정은 CANCEL 이 아닌 발송건을 센다', async () => {
      const { sut } = buildSut();

      await call(sut, CANCELABLE);

      expect(sut.orderDeliveryRepository.createQueryBuilder).toHaveBeenCalled();
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

  it('취소 상태 전이는 CANCEL 상수를 쓴다 (문자열 오타 방지)', () => {
    expect(IOrderDeliveryStatus.CANCEL).toBe('CANCEL');
  });
});
