import { BadRequestException, ConflictException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';

/**
 * CS 재전송(reSend) self-heal claim 회귀 테스트. (ralplan G001 / AC4·AC5-i)
 *
 * reSend 가 기존 비관락(SELECT FOR UPDATE)+@Transactional 에서 self-heal claim 으로 전환됐는지 검증:
 *  - 정상: claim 성공 → 락 없이 oneSend → owner-guarded 해제(claimedAt=null)
 *  - 동시성: claim affected=0(다른 요청 선점/stale 아님) → ConflictException, oneSend 미호출
 *  - 예외: oneSend throw → owner-guarded 해제 후 re-throw
 *
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 협력자만 mock 주입한다(discard-reissue.spec 관례).
 */
describe('CustomerServiceService — reSend self-heal claim', () => {
  const ORDER_DELIVERY_ID = 8001;
  const user = { id: 9, email: 'op@enmad.com' } as any;

  let service: any;
  let orderDeliveryRepository: any;
  let deliveryBatchService: any;
  let qb: any;

  const buildTarget = () =>
    ({
      id: ORDER_DELIVERY_ID,
      deliveryTarget: 'ENC_TARGET',
      orderProductMapping: { product: { type: 'GENERAL' } },
    }) as any;

  /** createQueryBuilder 가 반환하는 체이너블 mock — select(buildReSendQuery)·update(claim) 양쪽 체인 지원. */
  const makeQb = () => {
    const builder: any = {};
    for (const m of ['innerJoinAndSelect', 'leftJoinAndSelect', 'where', 'andWhere', 'update', 'set']) {
      builder[m] = jest.fn(() => builder);
    }
    builder.getOne = jest.fn();
    builder.execute = jest.fn();
    return builder;
  };

  beforeEach(() => {
    qb = makeQb();
    orderDeliveryRepository = {
      createQueryBuilder: jest.fn(() => qb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    deliveryBatchService = { oneSend: jest.fn().mockResolvedValue(true) };

    service = Object.create(CustomerServiceService.prototype);
    service.orderDeliveryRepository = orderDeliveryRepository;
    service.deliveryBatchService = deliveryBatchService;
    service.authService = { authorityValidator: jest.fn().mockResolvedValue(undefined) };
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    // 권한 매핑은 본 테스트 범위가 아니므로 truthy 로 고정
    service.resolveCsCouponAuthority = jest.fn().mockReturnValue('CUSTOMER_GENERAL_COUPON');
  });

  it('정상: claim 성공 → oneSend 호출 → owner-guarded 해제(claimedAt=null)', async () => {
    qb.getOne.mockResolvedValueOnce(buildTarget()).mockResolvedValueOnce(buildTarget());
    qb.execute.mockResolvedValue({ affected: 1 });

    await service.reSend(user, { orderDeliveryId: ORDER_DELIVERY_ID });

    expect(deliveryBatchService.oneSend).toHaveBeenCalledTimes(1);
    // 성공 종료 경로: owner guard(claimedAt=claimAt) 로 claimedAt=null 해제
    expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: ORDER_DELIVERY_ID, claimedAt: expect.any(Date) }),
      { claimedAt: null },
    );
  });

  it('동시성: claim affected=0 → ConflictException, oneSend 미호출', async () => {
    qb.getOne.mockResolvedValueOnce(buildTarget());
    qb.execute.mockResolvedValue({ affected: 0 });

    await expect(service.reSend(user, { orderDeliveryId: ORDER_DELIVERY_ID })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(deliveryBatchService.oneSend).not.toHaveBeenCalled();
    // claim 실패 시 release update 도 호출하지 않는다(claim 미소유)
    expect(orderDeliveryRepository.update).not.toHaveBeenCalled();
  });

  it('예외: oneSend throw → owner-guarded 해제 후 re-throw', async () => {
    qb.getOne.mockResolvedValueOnce(buildTarget()).mockResolvedValueOnce(buildTarget());
    qb.execute.mockResolvedValue({ affected: 1 });
    deliveryBatchService.oneSend.mockRejectedValue(new Error('send boom'));

    await expect(service.reSend(user, { orderDeliveryId: ORDER_DELIVERY_ID })).rejects.toThrow('send boom');
    expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: ORDER_DELIVERY_ID, claimedAt: expect.any(Date) }),
      { claimedAt: null },
    );
  });

  it('대상 없음: getOne null → BadRequestException, claim 미실행', async () => {
    qb.getOne.mockResolvedValueOnce(null);

    await expect(service.reSend(user, { orderDeliveryId: ORDER_DELIVERY_ID })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(qb.execute).not.toHaveBeenCalled();
    expect(deliveryBatchService.oneSend).not.toHaveBeenCalled();
  });

  it('claim WHERE: 상태집합(COMPLETE/COMPLETE_SMS/FAIL/FAIL_SMS) + 5분 stale self-heal 조건으로 구성', async () => {
    qb.getOne.mockResolvedValueOnce(buildTarget()).mockResolvedValueOnce(buildTarget());
    qb.execute.mockResolvedValue({ affected: 1 });
    const beforeMs = Date.now();

    await service.reSend(user, { orderDeliveryId: ORDER_DELIVERY_ID });

    // COMPLETE/COMPLETE_SMS 포함 전체 재발송 상태집합 (boot sweep 미커버 → per-row self-heal 필수)
    expect(qb.andWhere).toHaveBeenCalledWith('status IN (:...statuses)', {
      statuses: ['COMPLETE', 'FAIL', 'COMPLETE_SMS', 'FAIL_SMS'],
    });
    // 5분 stale self-heal 재claim 조건
    const staleCall = qb.andWhere.mock.calls.find((c: any[]) => c[0] === '(claimedAt IS NULL OR claimedAt < :stale)');
    expect(staleCall).toBeTruthy();
    const stale = (staleCall as any[])[1].stale as Date;
    const deltaMs = beforeMs - stale.getTime();
    expect(deltaMs).toBeGreaterThanOrEqual(5 * 60 * 1000 - 3000);
    expect(deltaMs).toBeLessThanOrEqual(5 * 60 * 1000 + 3000);
  });

  /**
   * D3-55 후속 — reSend 도 쿠폰상태 변형 lease 를 **획득**한다.
   *
   * reSend 는 claimedAt(재발송 직렬화)만 잡고 mutation lease 는 잡지 않았다. 그래서 oneSend
   * (외부 통신, 수 초) 도중 폐기(execDiscard)·외부취소(cancelOrder)가 같은 행에 진입해
   * 협력사 취소 + 환불을 마칠 수 있었다 → **이미 죽은 핀이 담긴 문자가 고객에게 배달**된다.
   * (외부 resendOrder 의 슬롯 CAS 를 "읽기 → 획득" 으로 고친 것과 같은 결함·같은 해법)
   *
   * lease 는 별도 CAS 가 아니라 **기존 claimedAt CAS 의 SET 에 얹어** 원자적으로 획득한다.
   * 별도 쿼리로 나누면 두 CAS 사이에 폐기가 끼어드는 창이 다시 생긴다.
   */
  describe('D3-55 후속 — 변형 lease 획득/해제', () => {
    const leaseReleases = () =>
      (orderDeliveryRepository.update.mock.calls as unknown as any[][]).filter(
        (c) => c[1] && c[1].mutationClaimedAt === null,
      );

    it('claim CAS 의 SET 에 mutationClaimedAt 이 함께 들어간다 — claimedAt 과 같은 토큰으로 원자 획득', async () => {
      qb.getOne.mockResolvedValueOnce(buildTarget()).mockResolvedValueOnce(buildTarget());
      qb.execute.mockResolvedValue({ affected: 1 });

      await service.reSend(user, { orderDeliveryId: ORDER_DELIVERY_ID });

      // set 은 claim CAS 에서 1회 — 읽기(WHERE)만 하고 SET 을 빼면 발송 구간 내내 lease 가 비어 있다
      expect(qb.set).toHaveBeenCalledTimes(1);
      const setArg = qb.set.mock.calls[0][0];
      expect(setArg.mutationClaimedAt).toBeInstanceOf(Date);
      // 소유자 식별이 일관되도록 두 lease 의 토큰이 동일해야 한다(해제도 같은 토큰으로 owner-guard)
      expect(setArg.mutationClaimedAt).toBe(setArg.claimedAt);
      // 쿠폰상태는 건드리지 않는다 — 남이 쓴 CANCEL 을 되돌리지 않기 위해
      expect(setArg).not.toHaveProperty('couponStatus');
    });

    it('claim CAS 의 WHERE 에 lease 술어 — 활성 lease(폐기/재발행 진행중)면 획득 실패, stale(5분 초과)은 강탈', async () => {
      qb.getOne.mockResolvedValueOnce(buildTarget()).mockResolvedValueOnce(buildTarget());
      qb.execute.mockResolvedValue({ affected: 1 });
      const beforeMs = Date.now();

      await service.reSend(user, { orderDeliveryId: ORDER_DELIVERY_ID });

      const leaseCall = (qb.andWhere.mock.calls as unknown as any[][]).find((c) =>
        /mutation_claimed_at/i.test(String(c[0])),
      );
      expect(leaseCall).toBeDefined(); // 없으면 폐기 진행중 행에도 재발송이 들어간다
      expect(String(leaseCall![0])).toMatch(/mutation_claimed_at IS NULL/i);
      expect(String(leaseCall![0])).toMatch(/mutation_claimed_at\s*<\s*:mutationStale/i);

      const mutationStale: Date = leaseCall![1].mutationStale;
      const deltaMs = beforeMs - mutationStale.getTime();
      expect(deltaMs).toBeGreaterThanOrEqual(5 * 60 * 1000 - 3000);
      expect(deltaMs).toBeLessThanOrEqual(5 * 60 * 1000 + 3000);
    });

    it('정상 종료: claimedAt 해제와 함께 변형 lease 도 owner-guarded 해제', async () => {
      qb.getOne.mockResolvedValueOnce(buildTarget()).mockResolvedValueOnce(buildTarget());
      qb.execute.mockResolvedValue({ affected: 1 });

      await service.reSend(user, { orderDeliveryId: ORDER_DELIVERY_ID });

      // 해제 안 하면 발송 직후부터 stale(5분)까지 그 행의 폐기·외부취소가 전부 거절된다
      const releases = leaseReleases();
      expect(releases).toHaveLength(1);
      expect(releases[0][0]).toEqual({ id: ORDER_DELIVERY_ID, mutationClaimedAt: expect.any(Date) });
      expect(releases[0][1]).toEqual({ mutationClaimedAt: null });
    });

    it('예외(oneSend throw) 경로에서도 변형 lease 를 해제한다', async () => {
      qb.getOne.mockResolvedValueOnce(buildTarget()).mockResolvedValueOnce(buildTarget());
      qb.execute.mockResolvedValue({ affected: 1 });
      deliveryBatchService.oneSend.mockRejectedValue(new Error('send boom'));

      await expect(service.reSend(user, { orderDeliveryId: ORDER_DELIVERY_ID })).rejects.toThrow('send boom');

      expect(leaseReleases()).toHaveLength(1);
    });

    it('claim 실패(409) 시에는 lease 해제를 시도하지 않는다 — 남의 lease 를 건드리지 않음', async () => {
      qb.getOne.mockResolvedValueOnce(buildTarget());
      qb.execute.mockResolvedValue({ affected: 0 });

      await expect(service.reSend(user, { orderDeliveryId: ORDER_DELIVERY_ID })).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(leaseReleases()).toHaveLength(0);
    });
  });
});
