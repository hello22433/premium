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

  /**
   * 리뷰 CONFIRMED: UpdateQueryBuilder 는 soft-delete 필터를 **자동 적용하지 않는다**
   * (SelectQueryBuilder 와 달리). unwindReissue 가 softDelete 한 tip 이 status=WAIT /
   * coupon_status=NOT_USED 로 남아 있으면, 이 조건 없이는 배치가 집어 PIN 을 발급·발송한다.
   * 폐기 역전으로 원본이 이미 살아났다면 고객 쿠폰이 2장이 되고, SSG 는 선차감까지 역복원된
   * 뒤라 미차감 발급이 된다.
   */
  it('soft-delete 된 행은 집지 않는다 (UpdateQueryBuilder 는 deleted_at 을 자동 필터링하지 않는다)', async () => {
    await sut.claimWaitDeliveries(new Date());

    expect(qb.andWhere.mock.calls.some((c: any[]) => /deleted_at IS NULL/i.test(String(c[0])))).toBe(true);
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

  /**
   * D3-60 — oneSend(CS 재발송 / 발송실패내역 재발송 진입점) 에도 full save() 가 없다.
   *
   * 배치(processOneDeliveryInternal)만 고치고 oneSend 를 두면 clobber 는 그대로 남는다.
   * 변형 lease 는 5분 stale 이라 발송(외부 통신) 도중 폐기가 lease 를 **강탈**할 수 있고,
   * 그때 save 는 남이 쓴 coupon_status=CANCEL / deleted_at 을 스냅샷으로 되돌린다.
   * lease 는 "남의 진입"을 막을 뿐 "이미 들어온 값을 되돌리는 것"은 못 막는다 — 그건 save 의 문제다.
   */
  describe('oneSend — full save() 부재 (persistOneSendResult)', () => {
    it('persistOneSendResult 의 SET 은 6컬럼뿐 — clobber 3컬럼 없음', async () => {
      const od = makeDelivery({ actualSendAt: new Date(), failedAt: null });

      await (sut as any).persistOneSendResult(od);

      expect(repo.update).toHaveBeenCalledTimes(1);
      const [criteria, set] = repo.update.mock.calls[0];
      expect(criteria).toEqual({ id: 901 });
      // oneSend 가 엔티티에 쓰는 컬럼의 전부(전수 확인). 여기 없는 컬럼은 각자 자체 update 로 영속한다.
      expect(Object.keys(set).sort()).toEqual([
        'actualSendAt',
        'encourageAt',
        'expireAt',
        'failedAt',
        'imagePath',
        'status',
      ]);
      expect(set).not.toHaveProperty('couponStatus');
      expect(set).not.toHaveProperty('mutationClaimedAt');
      expect(set).not.toHaveProperty('deletedAt');
    });

    it('PIN 재발급 실패 경로: save() 대신 targeted update', async () => {
      const od = makeDelivery({ status: IOrderDeliveryStatus.WAIT }); // wasFailBefore=false → 환불 분기 미진입
      (sut as any).reissuePinAndCreateImageIfNeeded = jest.fn().mockResolvedValue(false);
      (sut as any).deliverySendHistoryRepository = { save: jest.fn().mockResolvedValue(undefined) };

      const sent = await (sut as any).oneSend(od);

      expect(sent).toBe(false);
      expect(repo.save).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledTimes(1);
      expect(repo.update.mock.calls[0][1]).not.toHaveProperty('couponStatus');
    });

    /**
     * ★ 성공(발송 완료) 경로를 **실제로 통과시켜** 영속 계약을 잠근다.
     *
     * 위 두 테스트의 공백: 287 은 persistOneSendResult 를 직접 호출하고, 309 는 PIN 재발급 실패
     * 조기 return 만 탄다. 즉 oneSend 의 **성공 경로 말미**(`if (isSave) await this.persistOneSendResult(...)`)
     * 는 어떤 테스트도 통과하지 않았다. 그 줄을 `save(orderDelivery)` 로 되돌려도(=D3-60 clobber 재발),
     * 혹은 통째로 지워도(발송 결과 소실) 전 스위트가 초록이었다.
     *
     * 이 경로는 CS 재발송(reSend)·발송실패내역 재발송의 실제 진입점이고, 둘 다 변형 lease 를
     * 5분 stale 로 들고 외부 통신(PIN 발급+문자)을 하는 구간이라 clobber 창이 가장 넓다.
     */
    const setupOneSendSuccess = (od: any) => {
      (sut as any).reissuePinAndCreateImageIfNeeded = jest.fn().mockResolvedValue(true);
      (sut as any).deliverySendHistoryRepository = { save: jest.fn().mockResolvedValue(undefined) };
      (sut as any).smsSend = { send: jest.fn().mockResolvedValue(undefined) };
      // shadow 추적은 발송을 대행하지 않는다 — 상관키 없이 그대로 통과시키는 스텁.
      (sut as any).messageAttemptService = {
        trackSend: (_ctx: unknown, send: (attemptId?: string) => Promise<unknown>) => send(undefined),
      };
      (sut as any).buildSmsText = jest.fn().mockReturnValue('본문');
      // markSendSuccess 는 deliverySendService 로 위임된다(프로덕션 174行).
      (sut as any).deliverySendService.markSendSuccess = jest.fn((d: any, status: any) => {
        d.status = status;
        d.actualSendAt = new Date('2026-07-14T03:00:00.000Z');
      });
      od.orderProductMapping.fromPhoneNumber = '16443614';
      return od;
    };

    it('발송 성공 경로: save() 를 호출하지 않는다 — persistOneSendResult 로만 영속 (D3-60 회귀 방지)', async () => {
      const od = setupOneSendSuccess(makeDelivery({ status: IOrderDeliveryStatus.WAIT }));

      const sent = await (sut as any).oneSend(od);

      expect(sent).toBe(true);
      expect((sut as any).smsSend.send).toHaveBeenCalled(); // 발송 경로를 실제로 통과했다
      // save 가 한 번이라도 나가면 coupon_status=CANCEL / deleted_at / 남의 mutation_claimed_at 이
      // 발송 시작 시점 스냅샷으로 되돌아간다 = 환불됐는데 살아있는 쿠폰.
      expect(repo.save).not.toHaveBeenCalled();
      // 영속을 통째로 지우는 회귀도 잡는다 — update 가 0회면 발송 결과(status/actualSendAt)가 유실된다.
      expect(repo.update).toHaveBeenCalledTimes(1);
      const [criteria, set] = repo.update.mock.calls[0];
      expect(criteria).toEqual({ id: 901 });
      expect(Object.keys(set).sort()).toEqual([
        'actualSendAt',
        'encourageAt',
        'expireAt',
        'failedAt',
        'imagePath',
        'status',
      ]);
    });

    /**
     * ★ 컬럼 이름만 맞고 **값**이 엉뚱하면 그 값은 조용히 사라진다.
     *
     * 287 은 Object.keys 만 본다. `imagePath: undefined` (TypeORM 이 컬럼을 통째로 스킵) 나
     * `expireAt: orderDelivery.encourageAt` 같은 오결선은 키 집합이 그대로라 통과한다.
     * 6컬럼 각각이 **엔티티의 자기 필드**에서 온다는 것까지 잠근다.
     */
    it('persistOneSendResult: 6컬럼이 각각 엔티티의 해당 필드 값으로 쓰인다 (오결선/undefined 차단)', async () => {
      const od = makeDelivery({
        status: IOrderDeliveryStatus.COMPLETE,
        actualSendAt: new Date('2026-07-14T01:00:00.000Z'),
        failedAt: new Date('2026-07-14T02:00:00.000Z'),
        expireAt: new Date('2026-08-14T00:00:00.000Z'),
        encourageAt: new Date('2026-08-07T00:00:00.000Z'),
        imagePath: 'img/coupon-901.png',
      });

      await (sut as any).persistOneSendResult(od);

      const [, set] = repo.update.mock.calls[0];
      expect(set).toEqual({
        status: IOrderDeliveryStatus.COMPLETE,
        actualSendAt: new Date('2026-07-14T01:00:00.000Z'),
        failedAt: new Date('2026-07-14T02:00:00.000Z'),
        expireAt: new Date('2026-08-14T00:00:00.000Z'),
        encourageAt: new Date('2026-08-07T00:00:00.000Z'),
        imagePath: 'img/coupon-901.png',
      });
      // imagePath 는 자체 update 가 없는 유일한 컬럼 — 여기서 빠지면 쿠폰 이미지가 영영 유실된다.
      expect(set.imagePath).toBe('img/coupon-901.png');
    });

    it('isSave=false: 발송은 하되 영속은 하지 않는다 (테스트 발송이 실 데이터를 덮지 않는다)', async () => {
      const od = setupOneSendSuccess(makeDelivery({ status: IOrderDeliveryStatus.WAIT }));

      await (sut as any).oneSend(od, false);

      expect((sut as any).smsSend.send).toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  /**
   * 리뷰 HIGH — D3-60 수정(save→targeted update)은 "무엇을 쓰나"만 좁혔고
   * "쓸 자격이 있나"는 `{ id }` 조건 그대로였다.
   *
   * PIN 발급·문자 발송은 외부 통신이라 수 초~수십 초가 걸리고 변형 lease 는 5분 stale
   * self-heal 이다. 그 사이 폐기·외부취소·재발행이 lease 를 가져가 상태를 확정하면,
   * 배치가 **남이 확정한 상태 위에 자기 결과를 덮어썼다.**
   */
  describe('변형 lease fencing (리뷰 HIGH)', () => {
    const TOKEN = new Date('2026-07-24T03:00:00.000Z');

    it('claimToken 을 넘기면 모든 상태 쓰기의 where 에 내 토큰이 실린다', async () => {
      await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN);

      expect(repo.update).toHaveBeenCalled();
      for (const [where] of repo.update.mock.calls as unknown as any[][]) {
        expect(where).toEqual({ id: 901, mutationClaimedAt: TOKEN });
      }
    });

    it('토큰이 없으면 종전대로 무울타리 — 기존 호출 경로가 깨지지 않는다', async () => {
      await (sut as any).processOneDeliveryInternal(makeDelivery());

      for (const [where] of repo.update.mock.calls as unknown as any[][]) {
        expect(where).toEqual({ id: 901 });
      }
    });

    it('PIN 발급 실패 경로도 fencing 된다', async () => {
      const od = makeDelivery({ barCode: null, imagePath: null });
      (sut as any).partnerCompanyExternService.issue.mockRejectedValue(new Error('발급 실패'));

      await (sut as any).processOneDeliveryInternal(od, TOKEN);

      const failWrite = (repo.update.mock.calls as unknown as any[][]).find((c) => c[1] && 'status' in c[1]);
      expect(failWrite![0]).toEqual({ id: 901, mutationClaimedAt: TOKEN });
    });

    it('lease 를 뺏겨 affected=0 이어도 예외를 던지지 않는다 — 이미 나간 문자의 중복 발송 방지', async () => {
      repo.update.mockResolvedValue({ affected: 0 });

      // 예외를 던지면 processOneDeliveryForBatch 의 catch → claimedAt reset → 다음 cron 재발송이 된다.
      await expect((sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN)).resolves.toBeDefined();
    });

    it('lease 상실은 무음이 아니다 — [BATCH_FENCE_LOST] 경보 (orderId 포함)', async () => {
      repo.update.mockResolvedValue({ affected: 0 });

      await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN);

      // 운영이 잃은 쓰기를 대사할 때 order 조인을 손으로 안 하도록 orderId 를 함께 남긴다(리뷰 P1).
      const msg = (sut as any).logger.error.mock.calls.map((c: any[]) => c[0]).find((m: string) => m?.includes('[BATCH_FENCE_LOST]'));
      expect(msg).toContain('[BATCH_FENCE_LOST]');
      expect(msg).toContain('orderId: 55');
    });

    it('정상 소유(affected=1)면 경보하지 않는다 — 오탐 방지', async () => {
      await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN);

      expect((sut as any).logger.error).not.toHaveBeenCalledWith(expect.stringContaining('[BATCH_FENCE_LOST]'));
    });

    it('1차(발송결과)에서 lease 를 잃으면 2차(부가컬럼)는 시도조차 하지 않는다', async () => {
      // 대조군: 정상 소유일 땐 2차 쓰기가 **반드시 나간다**(없으면 아래 단언이 공허해진다)
      await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN);
      const controlWrite = (repo.update.mock.calls as unknown as any[][]).find((c) => c[1] && 'imagePath' in c[1]);
      expect(controlWrite).toBeDefined();

      repo.update.mockClear();
      repo.update.mockResolvedValue({ affected: 0 });

      await (sut as any).processOneDeliveryInternal(makeDelivery(), TOKEN);

      // 반쪽 행(상태는 남의 것 + 이미지/유효기간은 내 것) 금지
      const extraWrite = (repo.update.mock.calls as unknown as any[][]).find((c) => c[1] && 'imagePath' in c[1]);
      expect(extraWrite).toBeUndefined();
    });

    it('persistOneSendResult: 토큰을 넘기면 fencing 된다 (CS·발송실패내역 재발송 경로)', async () => {
      await (sut as any).persistOneSendResult(makeDelivery(), TOKEN);

      const [where] = repo.update.mock.calls[0];
      expect(where).toEqual({ id: 901, mutationClaimedAt: TOKEN });
    });
  });
});
