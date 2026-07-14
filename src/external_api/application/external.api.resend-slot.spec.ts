import { ExternalApiService } from './external.api.service';

import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { MUTATION_CLAIM_STALE_MS } from '../../delivery/interface/order.delivery.mutation.claim';

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

  return { svc, orderDelivery, set, execute, createQueryBuilder, update, findOne, qb };
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

  /**
   * 리뷰 CONFIRMED: 슬롯 CAS 가 lease 를 WHERE 로 "읽기"만 하고 SET 으로 "획득"하지 않으면,
   * dispatchSend(외부 발송, 수 초) 동안 lease 가 비어 있다. 그 사이 폐기/취소가 진입해
   * 협력사 취소 + 환불을 마치면, 이 재발송은 이미 죽은 핀을 고객에게 배달하고
   * 최종 update 로 status=COMPLETE 를 되살린다.
   */
  describe('변형 lease — 읽기가 아니라 획득/fencing/해제', () => {
    it('슬롯 선점 CAS 의 SET 에 mutationClaimedAt 이 포함된다 (발송 구간 내내 lease 보유)', async () => {
      const { svc, set } = makeService({ claimAffected: 1 });

      await svc.resendOrder(account, 'TR-RESEND', ctx);

      const setArg = (set.mock.calls[0] as any[])[0];
      expect(setArg.resendCount()).toBe('resend_count + 1');
      expect(setArg.mutationClaimedAt).toBeInstanceOf(Date); // ← 획득
    });

    it('발송 후 update 는 내 lease 로 fencing 된다 (좀비의 status=COMPLETE 되살림 차단)', async () => {
      const { svc, update } = makeService({ claimAffected: 1 });

      await svc.resendOrder(account, 'TR-RESEND', ctx);

      const calls = update.mock.calls as unknown as any[][];
      const sendWrite = calls.find((c) => c[1] && 'resendAt' in c[1]) as any[];
      expect(sendWrite).toBeDefined();
      expect(sendWrite[0]).toEqual({ id: expect.anything(), mutationClaimedAt: expect.any(Date) });
    });

    it('슬롯 CAS 의 WHERE 에 lease 술어가 있고 stale 임계 = claimAt-5분 (활성 lease 만 배제, stale 은 강탈)', async () => {
      const { svc, qb, set } = makeService({ claimAffected: 1 });

      await svc.resendOrder(account, 'TR-RESEND', ctx);

      const claimAt: Date = (set.mock.calls[0] as any[])[0].mutationClaimedAt;
      const cas = (qb.andWhere as jest.Mock).mock.calls.find((c: any[]) => /mutation_claimed_at/i.test(String(c[0])));
      expect(cas).toBeDefined(); // 술어가 없으면 재발행 진행중 tip 에 이중 발송
      expect(String(cas![0])).toMatch(/mutation_claimed_at IS NULL/i);
      expect(String(cas![0])).toMatch(/mutation_claimed_at\s*<\s*:mutationStale/i);
      expect(cas![1].mutationStale.getTime()).toBe(claimAt.getTime() - MUTATION_CLAIM_STALE_MS);
    });

    it('슬롯 CAS 의 SET 절에 couponStatus/discardedAt 이 없다 (남이 쓴 CANCEL 을 되돌리지 않는다)', async () => {
      const { svc, set, update } = makeService({ claimAffected: 1 });

      await svc.resendOrder(account, 'TR-RESEND', ctx);

      for (const setArg of [(set.mock.calls[0] as any[])[0], (update.mock.calls[0] as any[])[1]]) {
        expect(setArg).not.toHaveProperty('couponStatus');
        expect(setArg).not.toHaveProperty('discardedAt');
      }
      // 발송결과 update 는 자기 소유 컬럼만
      expect(Object.keys((update.mock.calls[0] as any[])[1]).sort()).toEqual([
        'actualSendAt',
        'resendAt',
        'status',
      ]);
    });

    it('fencing: 발송결과 update 가 affected=0(lease 강탈당한 좀비)이면 throw 없이 로그만 — 상태를 되살리지 않는다', async () => {
      const { svc, update } = makeService({ claimAffected: 1 });
      update.mockResolvedValue({ affected: 0 } as any); // 내 lease 가 이미 남에게 넘어감

      // 발송 자체는 성공했으므로 응답은 성공. 다만 DB 상태는 덮지 않는다(남의 CANCEL 유지).
      const res = await svc.resendOrder(account, 'TR-RESEND', ctx);
      expect(res.code).toBe('0000');

      const lost = ((svc as any).logger.error as jest.Mock).mock.calls.filter((c: any[]) =>
        String(c[0]).includes('변형 lease 상실'),
      );
      expect(lost).toHaveLength(1);
    });

    it('성공/실패 모두 finally 에서 owner-guarded 해제', async () => {
      const releaseOf = (update: jest.Mock) =>
        (update.mock.calls as unknown as any[][]).filter((c) => c[1] && c[1].mutationClaimedAt === null);

      const ok = makeService({ claimAffected: 1 });
      await ok.svc.resendOrder(account, 'TR-RESEND', ctx);
      expect(releaseOf(ok.update)).toHaveLength(1);
      expect(releaseOf(ok.update)[0][0]).toEqual({
        id: expect.anything(),
        mutationClaimedAt: expect.any(Date),
      });

      const failed = makeService({
        claimAffected: 1,
        dispatch: jest.fn(async () => ({ isSuccess: false })) as any,
      });
      await expect(failed.svc.resendOrder(account, 'TR-RESEND', ctx)).rejects.toMatchObject({ code: '3003' });
      expect(releaseOf(failed.update)).toHaveLength(1);
    });
  });
});
