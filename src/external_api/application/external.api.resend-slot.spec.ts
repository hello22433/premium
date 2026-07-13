import { ExternalApiService } from './external.api.service';

import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

// 외부 API 재발송 atomic slot claim 계약 고정.
// - 발송 전 원자적 슬롯 선점(resend_count + 1, 한도/취소 가드)
// - 발송 실패 시 슬롯 롤백(현행 정책: 성공만 카운트)
// - 성공 시 save(orderDelivery) 대신 targeted update (resendCount stale 덮어쓰기 방지)

const account = { resendMaxCount: 3, user: { id: 42 } } as any;
const ctx = { apiApp: { id: '1' }, apiCredential: { id: '1' }, billingUserId: 42 } as any;

function makeOrderDelivery(over?: {
  status?: IOrderDeliveryStatus;
  couponStatus?: OrderDeliveryCouponStatus;
  barCode?: string | null;
  orderStatus?: IOrderStatus;
}) {
  return {
    id: 55,
    externalTrId: 'TR-RESEND',
    status: over?.status ?? IOrderDeliveryStatus.WAIT,
    actualSendAt: new Date('2026-06-22T00:00:00.000Z'),
    couponStatus: over?.couponStatus ?? OrderDeliveryCouponStatus.NOT_USED,
    barCode: over?.barCode === undefined ? '8801234567890' : over.barCode,
    resendCount: 0,
    orderProductMapping: {
      order: { status: over?.orderStatus ?? IOrderStatus.DELIVERY_COMPLETE },
    },
  } as any;
}

function makeService(opts?: {
  orderDelivery?: any;
  claimAffected?: number;
  fresh?: { resendCount?: number; couponStatus?: OrderDeliveryCouponStatus; mutationClaimedAt?: Date | null };
  dispatch?: jest.Mock;
}) {
  const orderDelivery = opts?.orderDelivery ?? makeOrderDelivery();
  const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  (svc as any).findOrderDeliveryByTrId = jest.fn(async () => orderDelivery);

  const set = jest.fn(() => qb);
  const execute = jest.fn(async () => ({ affected: opts?.claimAffected ?? 1 }));
  const qb: any = {
    update: jest.fn(() => qb),
    set,
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    execute,
  };
  const createQueryBuilder = jest.fn(() => qb);
  const update = jest.fn(async () => ({ affected: 1 }));
  const findOne = jest.fn(async () => ({
    resendCount: opts?.fresh?.resendCount ?? 3,
    couponStatus: opts?.fresh?.couponStatus ?? OrderDeliveryCouponStatus.NOT_USED,
    mutationClaimedAt: opts?.fresh?.mutationClaimedAt ?? null,
  }));
  (svc as any).orderDeliveryRepository = { createQueryBuilder, update, findOne };
  (svc as any).dispatchSend = opts?.dispatch ?? jest.fn(async () => ({ isSuccess: true }));

  return { svc, orderDelivery, set, execute, createQueryBuilder, update, findOne };
}

describe('ExternalApiService.resendOrder atomic slot claim', () => {
  it('정상 재발송: 슬롯 선점(1회) + 발송 1회 + targeted update(save 아님)', async () => {
    const { svc, execute, update, createQueryBuilder } = makeService({ claimAffected: 1 });

    const res = await svc.resendOrder(account, 'TR-RESEND', ctx);

    expect(res.code).toBe('0000');
    expect((svc as any).dispatchSend).toHaveBeenCalledTimes(1);
    // 슬롯 선점 UPDATE 1회 (롤백 없음)
    expect(execute).toHaveBeenCalledTimes(1);
    // 슬롯 선점 increment 표현 검증
    const setArg = (createQueryBuilder.mock.results[0].value.set as jest.Mock).mock.calls[0][0];
    expect(setArg.resendCount()).toBe('resend_count + 1');
    // resendAt 등은 targeted update, resendCount 는 포함하지 않음(이미 DB +1)
    const updateArg = (update.mock.calls[0] as any[])[1];
    expect(updateArg).toHaveProperty('resendAt');
    expect(updateArg).not.toHaveProperty('resendCount');
  });

  it('한도 도달: 슬롯 선점 affected=0 → 3008 (발송 안 함)', async () => {
    const { svc } = makeService({ claimAffected: 0, fresh: { resendCount: 3 } });

    await expect(svc.resendOrder(account, 'TR-RESEND', ctx)).rejects.toMatchObject({ code: '3008' });
    expect((svc as any).dispatchSend).not.toHaveBeenCalled();
  });

  it('직전 취소/폐기로 선점 실패(affected=0, couponStatus=CANCEL) → 3005', async () => {
    const { svc } = makeService({
      claimAffected: 0,
      fresh: { resendCount: 1, couponStatus: OrderDeliveryCouponStatus.CANCEL },
    });

    await expect(svc.resendOrder(account, 'TR-RESEND', ctx)).rejects.toMatchObject({ code: '3005' });
    expect((svc as any).dispatchSend).not.toHaveBeenCalled();
  });

  it('변형 lease 활성(재발행/폐기 진행중)으로 선점 실패 → 3010 (D3-55 후속, 이중 발송 차단)', async () => {
    const { svc } = makeService({
      claimAffected: 0,
      fresh: { resendCount: 1, mutationClaimedAt: new Date() }, // 활성 lease (stale 아님)
    });

    await expect(svc.resendOrder(account, 'TR-RESEND', ctx)).rejects.toMatchObject({ code: '3010' });
    expect((svc as any).dispatchSend).not.toHaveBeenCalled();
  });

  it('stale 변형 lease(5분 초과)는 선점을 막지 않는다 — affected=0 이면 3008 로 분류', async () => {
    const { svc } = makeService({
      claimAffected: 0,
      fresh: { resendCount: 3, mutationClaimedAt: new Date(Date.now() - 6 * 60 * 1000) }, // stale
    });

    await expect(svc.resendOrder(account, 'TR-RESEND', ctx)).rejects.toMatchObject({ code: '3008' });
  });

  it('발송 실패(isSuccess=false): 선점 슬롯 롤백 후 3003', async () => {
    const dispatch = jest.fn(async () => ({ isSuccess: false }));
    const { svc } = makeService({ claimAffected: 1, dispatch });
    const releaseSpy = jest.spyOn(svc as any, 'releaseResendSlot').mockResolvedValue(undefined);

    await expect(svc.resendOrder(account, 'TR-RESEND', ctx)).rejects.toMatchObject({ code: '3003' });
    expect(releaseSpy).toHaveBeenCalledWith(55);
  });

  it('발송 throw: 선점 슬롯 롤백 후 원본 에러 rethrow', async () => {
    const boom = new Error('gateway down');
    const dispatch = jest.fn(async () => {
      throw boom;
    });
    const { svc } = makeService({ claimAffected: 1, dispatch });
    const releaseSpy = jest.spyOn(svc as any, 'releaseResendSlot').mockResolvedValue(undefined);

    await expect(svc.resendOrder(account, 'TR-RESEND', ctx)).rejects.toBe(boom);
    expect(releaseSpy).toHaveBeenCalledWith(55);
  });

  it('미발행 쿠폰(barCode 없음): 선점 전 3004', async () => {
    const { svc, execute } = makeService({ orderDelivery: makeOrderDelivery({ barCode: null }) });

    await expect(svc.resendOrder(account, 'TR-RESEND', ctx)).rejects.toMatchObject({ code: '3004' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('발송 완료되지 않은 주문(order.status≠DELIVERY_COMPLETE): 선점 전 3005', async () => {
    const { svc, execute } = makeService({
      orderDelivery: makeOrderDelivery({ orderStatus: IOrderStatus.DELIVERY_CANCEL }),
    });

    await expect(svc.resendOrder(account, 'TR-RESEND', ctx)).rejects.toMatchObject({ code: '3005' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('releaseResendSlot: 음수 방지 GREATEST 차감 UPDATE 발행', async () => {
    const { svc, set, execute } = makeService();

    await (svc as any).releaseResendSlot(55);

    expect(execute).toHaveBeenCalledTimes(1);
    const setArg = (set.mock.calls[0] as any[])[0];
    expect(setArg.resendCount()).toBe('GREATEST(resend_count - 1, 0)');
  });
});
