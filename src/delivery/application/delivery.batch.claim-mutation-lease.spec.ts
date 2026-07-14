import { DeliveryBatchService } from './delivery.batch.service';
import { MUTATION_CLAIM_STALE_MS } from '../interface/order.delivery.mutation.claim';
import { OrderDeliveryCouponStatus } from '../interface/order.delivery.coupon.status';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderType } from '../../order/interface/order.type';
import { IProductType } from '../../product/interface/product.type';

/**
 * D3-55 후속 — 발송배치 claim 이 변형 lease(mutation_claimed_at) 활성 행을 제외하는지.
 *
 * 재발행(폐기후신규발송) tip 은 status=WAIT 로 INSERT 되므로, lease 제외가 없으면 발송배치가
 * 그 행을 집어가 재발행 자체 발송과 **이중 발송**이 된다(고객에게 문자 2통 + 발송비 중복).
 * 반대로 stale(5분 초과) lease 는 크래시 잔재이므로 정상 수거해야 한다 — 안 그러면 PIN 은
 * 발급됐는데 영원히 미발송으로 정체된다.
 *
 * 생성자 의존성이 많아 Object.create 로 프로토타입만 끌어오고 orderDeliveryRepository 만 주입한다.
 * (delivery.batch.release-claims.spec 관례)
 */
describe('DeliveryBatchService.claimWaitDeliveries — 변형 lease 제외 (D3-55 후속)', () => {
  let qb: any;
  let sut: DeliveryBatchService;

  beforeEach(() => {
    qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    sut = Object.create(DeliveryBatchService.prototype);
    (sut as any).orderDeliveryRepository = { createQueryBuilder: jest.fn(() => qb) };
  });

  /** WHERE 절 중 변형 lease 조건 (없으면 undefined). */
  const leaseCondition = (): any[] | undefined =>
    qb.andWhere.mock.calls.find((c: any[]) => /mutation_claimed_at/i.test(String(c[0])));

  it('claim WHERE 에 변형 lease 제외 조건이 포함된다 — 활성 lease(재발행 tip) 행은 배치가 집어가지 않는다', async () => {
    await sut.claimWaitDeliveries(new Date());

    const cond = leaseCondition();
    expect(cond).toBeDefined(); // 조건 자체가 없으면 재발행 tip 이중 발송
    // "비어 있거나(IS NULL) stale 인 행만" — 활성 lease 행은 매칭에서 빠진다
    expect(String(cond![0])).toMatch(/mutation_claimed_at IS NULL/i);
    expect(String(cond![0])).toMatch(/mutation_claimed_at\s*<\s*:mutationStale/i);
  });

  it('lease stale 임계 = claimedAt - 5분 (그보다 오래된 lease 만 수거 — 크래시 잔재 self-heal)', async () => {
    const claimedAt = new Date('2026-07-14T03:00:00.000Z');

    await sut.claimWaitDeliveries(claimedAt);

    const cond = leaseCondition();
    const stale: Date = cond![1].mutationStale;
    expect(stale).toBeInstanceOf(Date);
    expect(stale.getTime()).toBe(claimedAt.getTime() - MUTATION_CLAIM_STALE_MS);
    expect(MUTATION_CLAIM_STALE_MS).toBe(5 * 60 * 1000);
  });

  /**
   * 리뷰 CONFIRMED(HIGH): stale lease 를 WHERE 로 통과시키기만 하고 SET 으로 탈취하지 않으면,
   * 원 소유자(좀비)의 fencing 조건(mutation_claimed_at = :myClaimAt)이 여전히 일치해
   * affected=1 로 성공한다 — fencing 이 설계된 바로 그 상황에서 발동하지 않는다.
   * 배치가 lease 를 실제로 가져와야 좀비의 쓰기가 affected=0 으로 떨어져 중단 경로를 탄다.
   */
  it('SET 절이 변형 lease 를 탈취한다 — 좀비의 fencing 이 실제로 발동하도록', async () => {
    const claimedAt = new Date();

    await sut.claimWaitDeliveries(claimedAt);

    const setArg = qb.set.mock.calls[0][0];
    expect(setArg).toEqual({ claimedAt, mutationClaimedAt: claimedAt });
  });

  it('SET 절에 쿠폰상태가 없다 — 배치 claim 은 coupon_status 를 덮지 않는다', async () => {
    await sut.claimWaitDeliveries(new Date());

    const setArg = qb.set.mock.calls[0][0];
    expect(setArg).not.toHaveProperty('couponStatus');
    expect(setArg).not.toHaveProperty('discardedAt');
  });

  /**
   * 리뷰 CONFIRMED(HIGH): status 와 coupon_status 는 서로 다른 축이다. 폐기(execDiscard)는
   * coupon_status 만 CANCEL 로 쓰고 status 는 건드리지 않으므로, 어떤 이유로든 WAIT 로 남은
   * 취소 행을 배치가 집어 "환불 완료된 죽은 핀"을 고객에게 발송할 수 있었다.
   */
  it('폐기/환불된 쿠폰(coupon_status CANCEL·REFUND_CANCEL)은 배치가 집지 않는다', async () => {
    await sut.claimWaitDeliveries(new Date());

    const call = qb.andWhere.mock.calls.find((c: any[]) => /coupon_status/i.test(String(c[0])));
    expect(call).toBeDefined();
    expect(call[1].blockedCouponStatuses).toEqual([
      OrderDeliveryCouponStatus.CANCEL,
      OrderDeliveryCouponStatus.REFUND_CANCEL,
    ]);
  });

  it('affected 를 그대로 반환한다 (undefined 면 0)', async () => {
    qb.execute.mockResolvedValueOnce({ affected: 3 });
    expect(await sut.claimWaitDeliveries(new Date())).toBe(3);

    qb.execute.mockResolvedValueOnce({});
    expect(await sut.claimWaitDeliveries(new Date())).toBe(0);
  });
});

/**
 * claim 이 변형 lease 를 탈취(위 스펙)하므로, 배치는 처리 종료 시 반드시 그것을 반납해야 한다.
 * 반납하지 않으면 발송 직후부터 stale(5분)까지 그 행에 대한 폐기·외부취소가 전부 거절된다
 * (acquireMutationLease 가 활성 lease 로 보고 affected=0).
 */
describe('DeliveryBatchService.processOneDeliveryForBatch — 변형 lease 반납 (D3-55 후속)', () => {
  const CLAIM_TOKEN = new Date('2026-07-14T10:00:00.123456Z');
  let update: jest.Mock;
  let sut: DeliveryBatchService;

  const makeDelivery = () => ({ id: 777, claimedAt: CLAIM_TOKEN, status: 'WAIT' }) as any;

  /** mutationClaimedAt=null 을 쓰는 update 호출 (= lease 해제). */
  const releaseCalls = () =>
    (update.mock.calls as unknown as any[][]).filter((c) => c[1] && c[1].mutationClaimedAt === null);

  beforeEach(() => {
    update = jest.fn().mockResolvedValue({ affected: 1 });
    sut = Object.create(DeliveryBatchService.prototype);
    (sut as any).orderDeliveryRepository = { update };
    (sut as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  it('성공 경로: finally 에서 owner-guarded 해제', async () => {
    (sut as any).processOneDeliveryInternal = jest.fn().mockResolvedValue({ deliveryHistory: {}, orderId: 1 });

    await (sut as any).processOneDeliveryForBatch(makeDelivery());

    expect(releaseCalls()).toHaveLength(1);
    expect(releaseCalls()[0][0]).toEqual({ id: 777, mutationClaimedAt: CLAIM_TOKEN });
  });

  it('실패 경로: claimedAt reset 과 별개로 변형 lease 도 해제된다', async () => {
    (sut as any).processOneDeliveryInternal = jest.fn().mockRejectedValue(new Error('발송 실패'));

    await (sut as any).processOneDeliveryForBatch(makeDelivery());

    expect(releaseCalls()).toHaveLength(1);
    expect(releaseCalls()[0][0]).toEqual({ id: 777, mutationClaimedAt: CLAIM_TOKEN });
  });

  it('실패 경로의 claimedAt reset 은 owner guard 를 건다 — 남의 claim 을 풀지 않는다', async () => {
    (sut as any).processOneDeliveryInternal = jest.fn().mockRejectedValue(new Error('발송 실패'));

    await (sut as any).processOneDeliveryForBatch(makeDelivery());

    const reset = (update.mock.calls as unknown as any[][]).find((c) => c[1] && c[1].claimedAt === null);
    expect(reset).toBeDefined();
    expect(reset![0]).toEqual({ id: 777, status: 'WAIT', claimedAt: CLAIM_TOKEN });
  });
});

/**
 * D3-60 — 배치 발송에 full save() 가 없다.
 *
 * save(orderDelivery) 는 merge 라 **행 전체**를 claim 시점 스냅샷으로 쓴다. 이 엔티티는
 * claimWaitDeliveries 가 읽은 뒤 issue()/발송(외부 통신, 수 초)을 거치는 동안 낡는다.
 * 그 사이 다른 액터가 쓴 값을 되돌린다:
 *   - coupon_status='CANCEL' → 'NOT_USED'   (환불은 끝났는데 되살아난 쿠폰 = 자금 손실)
 *   - mutation_claimed_at    → 스냅샷 값     (남의 변형 lease 무력화)
 *   - deleted_at             → NULL          (unwindReissue 가 지운 tip 부활 → 배치가 재발송)
 *
 * 따라서 이 메서드의 쓰기는 전부 targeted update 여야 한다. save 가 한 번이라도 호출되면
 * 위 세 컬럼이 전부 clobber 가능해지므로, "save 미호출" 자체를 계약으로 잠근다.
 */
describe('DeliveryBatchService.processOneDeliveryInternal — full save() 부재 (D3-60 clobber)', () => {
  let repo: { update: jest.Mock; save: jest.Mock };
  let sut: DeliveryBatchService;

  /** 발송 성공 경로용 delivery — barCode 있음(=PIN 발급 분기 skip) + MMS. */
  const makeDelivery = (over: Record<string, any> = {}) =>
    ({
      id: 901,
      status: IOrderDeliveryStatus.WAIT,
      barCode: 'PIN-1',
      imagePath: 'img/1.png',
      expireAt: new Date('2026-12-31T00:00:00.000Z'),
      encourageAt: null,
      deliveryMethod: IOrderSendMethod.MMS,
      deliveryTarget: 'ENC_TARGET',
      transactionId: 'TR-1',
      ssgEventId: null,
      // clobber 대상 3컬럼 — 스냅샷에는 "발송 전" 값이 들어 있다.
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      mutationClaimedAt: null,
      deletedAt: null,
      orderProductMapping: {
        sendTitle: 't',
        sendContent: 'body',
        sendTailText: null,
        galaxiaDuration: null,
        encourageDay: null,
        order: { id: 55, type: IOrderType.GENERAL },
        product: { type: IProductType.GENERAL, expireDay: 30, galaxiaDuration: null, memo: null, partnerCompany: {} },
      },
      ...over,
    }) as any;

  beforeEach(() => {
    repo = { update: jest.fn().mockResolvedValue({ affected: 1 }), save: jest.fn().mockResolvedValue(undefined) };
    sut = Object.create(DeliveryBatchService.prototype);
    (sut as any).orderDeliveryRepository = repo;
    (sut as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (sut as any).cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01011112222'),
      encryptDeliveryTarget: jest.fn().mockReturnValue('ENC_OUT'),
      encryptJson: jest.fn().mockReturnValue('ENC_KEY'),
    };
    (sut as any).configService = { get: jest.fn().mockReturnValue('false') };
    (sut as any).partnerCompanyExternService = { issue: jest.fn() };
    (sut as any).ssgEventRepository = { findOne: jest.fn() };
    (sut as any).ssgInsertStateService = { getState: jest.fn() };
    // 발송 성공: sendSms 가 in-memory 로 상태를 COMPLETE 로 표시한다(실서비스 markSendSuccess 경로).
    (sut as any).deliverySendService = {
      sendSms: jest.fn(async (od: any) => {
        od.status = IOrderDeliveryStatus.COMPLETE;
        od.actualSendAt = new Date();
      }),
      markSendFail: jest.fn((od: any, status: any) => {
        od.status = status;
        od.failedAt = new Date();
      }),
    };
    (sut as any).createCouponImage = jest.fn().mockResolvedValue('img/new.png');
    (sut as any).refundForFail = jest.fn().mockResolvedValue(undefined);
  });

  it('발송 성공 경로: save() 를 호출하지 않는다 — 쓰기는 전부 targeted update', async () => {
    await (sut as any).processOneDeliveryInternal(makeDelivery());

    // save 가 한 번이라도 나가면 coupon_status/mutation_claimed_at/deleted_at 이 전부 clobber 가능해진다
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalled();
  });

  it('발송 성공 경로: 어떤 update 의 SET 절에도 clobber 3컬럼이 없다', async () => {
    await (sut as any).processOneDeliveryInternal(makeDelivery());

    for (const [, set] of repo.update.mock.calls as unknown as any[][]) {
      expect(set).not.toHaveProperty('couponStatus'); // 환불된 쿠폰 되살림
      expect(set).not.toHaveProperty('mutationClaimedAt'); // 남의 변형 lease 무력화
      expect(set).not.toHaveProperty('deletedAt'); // soft-delete 된 tip 부활
    }
  });

  /**
   * PIN 발급 실패 경로는 종전에 save(orderDelivery) 로 status/failedAt 을 썼다. 그 시점 스냅샷은
   * issue() 시도 **전** 값이라, issue 가 수 초 걸리는 동안 들어온 폐기의 coupon_status=CANCEL 을
   * 그대로 되돌린다. markSendFail 이 만지는 두 컬럼만 targeted update 여야 한다.
   */
  it('PIN 발급 실패 경로: save() 없이 status/failedAt 만 targeted update', async () => {
    const od = makeDelivery({ barCode: null, imagePath: null });
    (sut as any).partnerCompanyExternService.issue.mockRejectedValue(new Error('발급 실패'));

    const result = await (sut as any).processOneDeliveryInternal(od);

    expect(repo.save).not.toHaveBeenCalled();
    // 최초 발송 실패는 환불 보류(B1) — refundForFail 미호출
    expect((sut as any).refundForFail).not.toHaveBeenCalled();

    const failWrite = (repo.update.mock.calls as unknown as any[][]).find((c) => c[1] && 'status' in c[1]);
    expect(failWrite).toBeDefined();
    expect(failWrite![0]).toEqual({ id: 901 });
    expect(Object.keys(failWrite![1]).sort()).toEqual(['failedAt', 'status']);
    expect(failWrite![1].status).toBe(IOrderDeliveryStatus.FAIL);
    expect(result.deliveryHistory.isSuccess).toBe(false);
  });
});
