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
});
