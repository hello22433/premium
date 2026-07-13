import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { SsgRefundOutcome } from '../../delivery/interface/ssg.refund.resolve';
import { IOrderType } from '../../order/interface/order.type';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

/**
 * '폐기 후 신규 발송' (discard-then-reissue) SSG 정합 회귀 테스트.
 *
 * 검증 대상:
 *  - SSG: 폐기 전에 발급가능 행사 확보(fail-fast). 없으면 폐기조차 안 함.
 *  - SSG 정상: 새로 확보한 행사 id 로 newDelivery.ssgEventId 세팅.
 *  - issue 실패 + RESTORED: 선차감 역복원 + reverseDiscard + softDelete.
 *  - issue 실패 + SKIPPED_CONFIRMED: 폐기 유지(reverseDiscard 미호출).
 *  - issue 실패 + DEFERRED: 폐기 유지(reverseDiscard 미호출).
 *  - save(newDelivery) 실패(pre-issue): 선차감 역복원 + reverseDiscard.
 *  - findOne null(pre-issue): 선차감 역복원 + reverseDiscard + softDelete.
 *  - issue 성공 but barCode 없음 + RESTORED: reverseDiscard + softDelete.
 *  - 비SSG(일반): SSG select/deduct 미호출.
 *
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 협력자만 mock 주입한다.
 * (discard-concurrency.spec 관례)
 */
describe('CustomerServiceService — 폐기 후 신규 발송 (discard-reissue)', () => {
  const VALID_PHONE = '01098765432';
  const ORDER_ID = 555;
  const PRICE = 10000;
  const EXPIRE_DAY = 30;

  let service: any;
  let deliveryBatchService: any;
  let partnerCompanyExternService: any;
  let orderDeliveryRepository: any;
  let orderHistoryRepository: any;
  let cryptoCipher: any;

  // 폐기 대상(원본) — execDiscard 가 반환하는 discardedDelivery 로도 재사용
  const buildDiscardedDelivery = () =>
    ({
      id: 7001,
      orderProductMappingId: 3001,
      deliveryMethod: 'SMS',
      deliveryTarget: 'ENC_OLD',
      barCode: 'OLDPIN',
      replaceCharacter1: null,
      replaceCharacter2: null,
      replaceCharacter3: null,
      settleFee: 0,
      settlePriceAdjustment: 0,
      emailReceiverPhone: null,
      ssgEventId: 99,
      choiceSelectProductId: null,
    }) as any;

  // map.orderDelivery — execHistory 진입 시 검증/분기에 쓰임
  const buildMapOrderDelivery = (orderType: IOrderType) =>
    ({
      id: 7001,
      deliveryMethod: 'SMS',
      orderProductMapping: {
        order: { id: ORDER_ID, type: orderType },
        product: { price: PRICE, expireDay: EXPIRE_DAY },
      },
    }) as any;

  const buildMap = (orderType: IOrderType) => ({
    orderDeliveryId: 7001,
    userId: 9,
    user: { id: 9, email: 'op@enmad.com' },
    type: '폐기 후 신규 발송',
    content: '',
    beforeChange: '',
    afterChange: VALID_PHONE,
    sendMethod: 'SMS',
    orderDelivery: buildMapOrderDelivery(orderType),
  });

  // findOne 이 반환하는 fullDelivery
  const buildFullDelivery = (orderType: IOrderType, ssgEvent: any, barCode?: string) =>
    ({
      id: 8001,
      barCode: barCode !== undefined ? barCode : orderType === IOrderType.SSG ? 'PIN123' : 'G1',
      deliveryMethod: 'SMS',
      ssgEvent,
      orderProductMapping: {
        order: { id: ORDER_ID, type: orderType },
        product: {
          price: PRICE,
          expireDay: EXPIRE_DAY,
          galaxiaDuration: null,
          partnerCompany: { validityStartsNextDay: false },
        },
        galaxiaDuration: null,
        encourageDay: null,
      },
    }) as any;

  // 공통 SSG 선차감 mock 세팅
  const setupSsgAcquired = () => {
    deliveryBatchService.selectAndDeductSsgEventForReissue.mockResolvedValue({
      event: { id: 7 },
      resendDeductionId: 'ULID1',
    });
  };

  // 공통 execDiscard spy 세팅
  const setupExecDiscard = () =>
    jest.spyOn(service as any, 'execDiscard').mockResolvedValue({
      orderDelivery: buildDiscardedDelivery(),
      beforeChange: OrderDeliveryCouponStatus.NOT_USED,
      refundStatus: 'SKIPPED',
    });

  // wallet-managed carry 공통 시나리오 — 원본→신규 allocation_line repoint + 신규에 INITIAL/DEDUCTED attempt 생성 검증.
  const expectWalletOwnershipCarried = async (orderType: IOrderType) => {
    if (orderType === IOrderType.SSG) setupSsgAcquired();
    setupExecDiscard(); // discardedDelivery.id = 7001
    const ssgEvent = orderType === IOrderType.SSG ? { id: 7 } : null;
    orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(orderType, ssgEvent)); // id 8001
    service.walletManagedPredicate.isWalletManaged.mockResolvedValue(true);

    const managerUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    const manager = {
      findOne: jest.fn().mockResolvedValue({ id: '12', walletAccountId: '3' }),
      update: managerUpdate,
      save: jest.fn().mockResolvedValue({ id: 'A1' }),
    };
    service.dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));

    await service.execHistory(buildMap(orderType));

    // wallet-managed 판정은 reissueOrderId(=555) 로
    expect(service.walletManagedPredicate.isWalletManaged).toHaveBeenCalledWith(ORDER_ID);
    // allocation_line repoint: 원본 7001 → 신규 8001
    expect(managerUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { allocationId: '12', orderDeliveryId: 7001 },
      { orderDeliveryId: 8001 },
    );
    // 신규 delivery 에 INITIAL/DEDUCTED attempt 생성
    const savedAttempt = manager.save.mock.calls.find((c: any[]) => c[1] && c[1].attemptType === 'INITIAL');
    expect(savedAttempt).toBeDefined();
    expect(savedAttempt[1].orderDeliveryId).toBe(8001);
    expect(savedAttempt[1].status).toBe('DEDUCTED');
  };

  beforeEach(() => {
    deliveryBatchService = {
      selectAndDeductSsgEventForReissue: jest.fn(),
      reverseSsgReissueDeduct: jest.fn(),
      reverseReissueDeductDirect: jest.fn().mockResolvedValue(undefined),
      markReissueIssueAttempted: jest.fn().mockResolvedValue(undefined),
      resolveReissuePendingKept: jest.fn().mockResolvedValue(undefined),
      csResendAsSms: jest.fn().mockResolvedValue(IOrderDeliveryStatus.COMPLETE),
      csResendAsMms: jest.fn().mockResolvedValue(undefined),
      csResendAsAlimTalk: jest.fn().mockResolvedValue(IOrderDeliveryStatus.COMPLETE),
      csResendAsEmail: jest.fn().mockResolvedValue(undefined),
    };
    partnerCompanyExternService = {
      issue: jest.fn().mockResolvedValue({ ssgNewIssue: true, ssgEventId: null }),
    };
    orderDeliveryRepository = {
      save: jest.fn().mockImplementation(async (e: any) => ({ id: 8001, ...e })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
      softDelete: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };
    orderHistoryRepository = {
      create: jest.fn((x: any) => x),
      save: jest.fn().mockResolvedValue(undefined),
    };
    cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01099998888'),
      encryptDeliveryTarget: jest.fn().mockReturnValue('ENC_NEW'),
    };

    service = Object.create(CustomerServiceService.prototype);
    service.deliveryBatchService = deliveryBatchService;
    service.partnerCompanyExternService = partnerCompanyExternService;
    service.orderDeliveryRepository = orderDeliveryRepository;
    service.orderHistoryRepository = orderHistoryRepository;
    service.cryptoCipher = cryptoCipher;
    // HIGH-3: Object.create 는 필드 이니셜라이저를 건너뜀 — logger 직접 주입
    service.logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
    // wallet 승계 경로 의존성 — 기본은 비-wallet (carry 조기 return)
    service.walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(false) };
    service.dataSource = { transaction: jest.fn() };
  });

  describe('reverseDiscard', () => {
    it('CANCEL 상태일 때만 원래 status 로 역전 + discardedAt=null', async () => {
      const execute = jest.fn().mockResolvedValue({ affected: 1 });
      const where = jest.fn().mockReturnValue({ execute });
      const set = jest.fn().mockReturnValue({ where });
      const update = jest.fn().mockReturnValue({ set });
      jest.spyOn(orderDeliveryRepository, 'createQueryBuilder').mockReturnValue({ update } as any);

      await (service as any).reverseDiscard(99, OrderDeliveryCouponStatus.NOT_USED);

      expect(set).toHaveBeenCalledWith({
        couponStatus: OrderDeliveryCouponStatus.NOT_USED,
        discardedAt: null,
      });
      expect(where).toHaveBeenCalledWith('id = :id AND coupon_status = :cancel', {
        id: 99,
        cancel: OrderDeliveryCouponStatus.CANCEL,
      });
    });
  });

  describe('execHistory — 폐기 후 신규 발송', () => {
    it('1) 발급가능 행사 없으면 폐기 안 하고 BadRequest', async () => {
      deliveryBatchService.selectAndDeductSsgEventForReissue.mockResolvedValue(null);
      const execDiscardSpy = jest.spyOn(service as any, 'execDiscard');

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow(/발급 가능한 행사가 없습니다/);

      expect(execDiscardSpy).not.toHaveBeenCalled();
    });

    it('2) 정상: 새로 확보한 행사 id 로 newDelivery.ssgEventId 세팅', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.SSG, { id: 7 }));

      await service.execHistory(buildMap(IOrderType.SSG));

      expect(partnerCompanyExternService.issue).toHaveBeenCalled();
      // 첫 save 에 넘긴 newDelivery 의 ssgEventId 검증
      const firstSavedEntity = orderDeliveryRepository.save.mock.calls[0][0];
      expect(firstSavedEntity.ssgEventId).toBe(7);
    });

    it('3) issue 실패 + RESTORED → 선차감 역복원 + reverseDiscard(먼저) + softDelete', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.SSG, { id: 7 }));
      partnerCompanyExternService.issue.mockRejectedValue(new Error('issue boom'));
      deliveryBatchService.reverseSsgReissueDeduct.mockResolvedValue(SsgRefundOutcome.RESTORED);
      const reverseDiscardSpy = jest.spyOn(service as any, 'reverseDiscard').mockResolvedValue(undefined);

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow();

      expect(deliveryBatchService.reverseSsgReissueDeduct).toHaveBeenCalledWith(
        expect.anything(),
        7,
        PRICE,
        ORDER_ID,
        'ULID1',
      );
      // MEDIUM-1: reverseDiscard 가 softDelete 보다 먼저 호출돼야 한다
      expect(reverseDiscardSpy).toHaveBeenCalledWith(7001, OrderDeliveryCouponStatus.NOT_USED);
      expect(orderDeliveryRepository.softDelete).toHaveBeenCalled();
      const reverseOrder = reverseDiscardSpy.mock.invocationCallOrder[0];
      const softDeleteOrder = orderDeliveryRepository.softDelete.mock.invocationCallOrder[0];
      expect(reverseOrder).toBeLessThan(softDeleteOrder);
    });

    it('4) issue 실패 + SKIPPED_CONFIRMED → 폐기 유지, InternalServerError(발송실패내역), reverseDiscard 미호출', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.SSG, { id: 7 }));
      partnerCompanyExternService.issue.mockRejectedValue(new Error('issue boom'));
      deliveryBatchService.reverseSsgReissueDeduct.mockResolvedValue(SsgRefundOutcome.SKIPPED_CONFIRMED);
      const reverseDiscardSpy = jest.spyOn(service as any, 'reverseDiscard').mockResolvedValue(undefined);

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow(InternalServerErrorException);
      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow(/발송실패내역/);

      expect(reverseDiscardSpy).not.toHaveBeenCalled();
      expect(orderDeliveryRepository.softDelete).not.toHaveBeenCalled();
    });

    it('5) issue 실패 + DEFERRED → 폐기 유지(reverseDiscard 미호출)', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.SSG, { id: 7 }));
      partnerCompanyExternService.issue.mockRejectedValue(new Error('issue boom'));
      deliveryBatchService.reverseSsgReissueDeduct.mockResolvedValue(SsgRefundOutcome.DEFERRED);
      const reverseDiscardSpy = jest.spyOn(service as any, 'reverseDiscard').mockResolvedValue(undefined);

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow(InternalServerErrorException);

      expect(reverseDiscardSpy).not.toHaveBeenCalled();
      expect(orderDeliveryRepository.softDelete).not.toHaveBeenCalled();
    });

    it('6) 일반쿠폰: SSG select/deduct 미호출', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));

      await service.execHistory(buildMap(IOrderType.GENERAL));

      expect(deliveryBatchService.selectAndDeductSsgEventForReissue).not.toHaveBeenCalled();
      expect(partnerCompanyExternService.issue).toHaveBeenCalled();
    });

    it('7) CRITICAL: save(newDelivery) 실패 → 선차감 역복원 + reverseDiscard 호출', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.save.mockRejectedValue(new Error('DB save boom'));
      deliveryBatchService.reverseSsgReissueDeduct.mockResolvedValue(SsgRefundOutcome.RESTORED);
      const reverseDiscardSpy = jest.spyOn(service as any, 'reverseDiscard').mockResolvedValue(undefined);

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow();

      expect(deliveryBatchService.reverseReissueDeductDirect).toHaveBeenCalledWith('ULID1', 7, ORDER_ID, PRICE);
      expect(deliveryBatchService.reverseSsgReissueDeduct).not.toHaveBeenCalled();
      expect(reverseDiscardSpy).toHaveBeenCalledWith(7001, OrderDeliveryCouponStatus.NOT_USED);
    });

    it('8) CRITICAL: findOne null → 선차감 역복원 + reverseDiscard + softDelete 호출', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      // save 는 성공하되 findOne 은 null 반환
      orderDeliveryRepository.save.mockResolvedValue({ id: 8001 });
      orderDeliveryRepository.findOne.mockResolvedValue(null);
      deliveryBatchService.reverseReissueDeductDirect.mockResolvedValue(undefined);
      const reverseDiscardSpy = jest.spyOn(service as any, 'reverseDiscard').mockResolvedValue(undefined);

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow();

      expect(deliveryBatchService.reverseReissueDeductDirect).toHaveBeenCalledWith('ULID1', 7, ORDER_ID, PRICE);
      expect(deliveryBatchService.reverseSsgReissueDeduct).not.toHaveBeenCalled();
      expect(reverseDiscardSpy).toHaveBeenCalledWith(7001, OrderDeliveryCouponStatus.NOT_USED);
      expect(orderDeliveryRepository.softDelete).toHaveBeenCalledWith(8001);
    });

    it('9) HIGH-2: issue 성공 but barCode 없음 + RESTORED → reverseDiscard + softDelete', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      // barCode 가 빈 문자열인 fullDelivery
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.SSG, { id: 7 }, ''));
      partnerCompanyExternService.issue.mockResolvedValue(undefined);
      deliveryBatchService.reverseSsgReissueDeduct.mockResolvedValue(SsgRefundOutcome.RESTORED);
      const reverseDiscardSpy = jest.spyOn(service as any, 'reverseDiscard').mockResolvedValue(undefined);

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow();

      expect(deliveryBatchService.reverseSsgReissueDeduct).toHaveBeenCalledWith(
        expect.anything(),
        7,
        PRICE,
        ORDER_ID,
        'ULID1',
      );
      expect(reverseDiscardSpy).toHaveBeenCalledWith(7001, OrderDeliveryCouponStatus.NOT_USED);
      expect(orderDeliveryRepository.softDelete).toHaveBeenCalled();
    });

    it('10) GENERAL + wallet-managed: 신규 delivery 로 allocation_line repoint + INITIAL attempt 생성', async () => {
      await expectWalletOwnershipCarried(IOrderType.GENERAL);
    });

    it('11) GENERAL + 비-wallet: carry 트랜잭션 미진입', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));
      service.walletManagedPredicate.isWalletManaged.mockResolvedValue(false);

      await service.execHistory(buildMap(IOrderType.GENERAL));

      expect(service.walletManagedPredicate.isWalletManaged).toHaveBeenCalledWith(ORDER_ID);
      expect(service.dataSource.transaction).not.toHaveBeenCalled();
    });

    it('12) SSG + wallet-managed: allocation_line repoint + INITIAL attempt 생성 (환불 drift 방지)', async () => {
      // SSG 도 고객 wallet 결제는 승계 대상 — 승계 누락 시 신규 SSG 쿠폰 폐기에서 attempt/line 부재로 환불이 drift abort 된다.
      await expectWalletOwnershipCarried(IOrderType.SSG);
    });
  });

  /**
   * D3-55 후속 — 재발행 tip 쓰기의 컬럼 소유권.
   *
   * fullDelivery 는 issue() 호출 전에 로드한 스냅샷이라 couponStatus/discardedAt 이 로드 시점 값으로 굳는다.
   * issue()/csResendAsXxx 는 외부 통신이라 수 초가 걸리고, 그 사이 폐기(execDiscard)나 외부 취소(cancelOrder)가
   * 같은 행에 CANCEL 을 쓸 수 있다. save(fullDelivery) 는 행 전체를 쓰므로(merge) 그 CANCEL 을 stale 값으로
   * 되돌려 "환불됐는데 살아있는 핀" 을 만든다. 따라서 tip 쓰기는 자기 소유 컬럼만 targeted update 해야 한다.
   *
   * 소유권: expireAt/encourageAt/status/actualSendAt/failedAt = 재발행
   *         couponStatus/discardedAt = 폐기·취소   (SET 절에 절대 등장하면 안 됨)
   *         barCode/personalCode/couponNum/ssgTransactionId = issue() 가 자체 targeted update 로 저장
   */
  describe('D3-55 후속 — tip 쓰기는 targeted update (stale save 로 couponStatus 를 덮지 않는다)', () => {
    /** update 호출 중 SET 절(2번째 인자)만 모은다. */
    const setClauses = () => orderDeliveryRepository.update.mock.calls.map((c: any[]) => c[1]);

    it('13) 재발행 성공 시 fullDelivery 를 save 하지 않는다 (save 는 tip INSERT 1회뿐)', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));

      await service.execHistory(buildMap(IOrderType.GENERAL));

      // save 는 newDelivery INSERT 한 번만. 이후 두 번의 쓰기는 update 로 나가야 한다.
      expect(orderDeliveryRepository.save).toHaveBeenCalledTimes(1);
      expect(orderDeliveryRepository.save.mock.calls[0][0]).toEqual(
        expect.objectContaining({ replacedFromId: 7001, couponStatus: OrderDeliveryCouponStatus.NOT_USED }),
      );
    });

    it('14) 어떤 update 의 SET 절에도 couponStatus/discardedAt 이 없다 (일반)', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));

      await service.execHistory(buildMap(IOrderType.GENERAL));

      expect(orderDeliveryRepository.update).toHaveBeenCalled();
      for (const set of setClauses()) {
        expect(set).not.toHaveProperty('couponStatus');
        expect(set).not.toHaveProperty('discardedAt');
        expect(set).not.toHaveProperty('ssgEventId'); // markConfirmed(REQUIRES_NEW) 소유 — outer tx 에서 쓰면 self-deadlock
      }
    });

    it('15) 어떤 update 의 SET 절에도 couponStatus/discardedAt 이 없다 (SSG)', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.SSG, { id: 7 }));

      await service.execHistory(buildMap(IOrderType.SSG));

      expect(orderDeliveryRepository.save).toHaveBeenCalledTimes(1);
      for (const set of setClauses()) {
        expect(set).not.toHaveProperty('couponStatus');
        expect(set).not.toHaveProperty('discardedAt');
        expect(set).not.toHaveProperty('ssgEventId');
      }
    });

    it('16) 발송 성공: status/actualSendAt/failedAt 만 tip(8001) 에 targeted update', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));

      await service.execHistory(buildMap(IOrderType.GENERAL));

      const sendUpdate = orderDeliveryRepository.update.mock.calls.find((c: any[]) => 'status' in c[1]);
      expect(sendUpdate).toBeDefined();
      // criteria 에 mutationClaimedAt(owner guard) = fencing — 내 lease 일 때만 기록
      expect(sendUpdate[0]).toEqual({ id: 8001, mutationClaimedAt: expect.any(Date) });
      expect(Object.keys(sendUpdate[1]).sort()).toEqual(['actualSendAt', 'failedAt', 'status']);
      expect(sendUpdate[1].status).toBe(IOrderDeliveryStatus.COMPLETE);
      expect(sendUpdate[1].actualSendAt).toBeInstanceOf(Date);
      expect(sendUpdate[1].failedAt).toBeUndefined();
    });

    it('17) 발송 실패: FAIL_SMS + failedAt 로 targeted update (couponStatus 는 여전히 미포함)', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));
      deliveryBatchService.csResendAsSms.mockRejectedValue(new Error('MMS gateway down'));

      // 발송 실패는 update/history 기록 후 caller 에게 throw 한다(발송실패내역 안내).
      await expect(service.execHistory(buildMap(IOrderType.GENERAL))).rejects.toThrow(/발송에 실패했습니다/);

      const sendUpdate = orderDeliveryRepository.update.mock.calls.find((c: any[]) => 'status' in c[1]);
      expect(sendUpdate[0]).toEqual({ id: 8001, mutationClaimedAt: expect.any(Date) });
      expect(sendUpdate[1].status).toBe(IOrderDeliveryStatus.FAIL_SMS);
      expect(sendUpdate[1].failedAt).toBeInstanceOf(Date);
      expect(sendUpdate[1].actualSendAt).toBeUndefined();
      expect(sendUpdate[1]).not.toHaveProperty('couponStatus');
    });

    it('18) 비SSG 만 유효기간 update (SSG 는 issue() 가 expireAt 을 채우므로 쓰지 않는다)', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));
      await service.execHistory(buildMap(IOrderType.GENERAL));

      const generalExpiry = orderDeliveryRepository.update.mock.calls.filter((c: any[]) => 'expireAt' in c[1]);
      expect(generalExpiry).toHaveLength(1);
      expect(generalExpiry[0][0]).toEqual({ id: 8001, mutationClaimedAt: expect.any(Date) });
      expect(Object.keys(generalExpiry[0][1]).sort()).toEqual(['encourageAt', 'expireAt']);

      jest.clearAllMocks();
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.save.mockImplementation(async (e: any) => ({ id: 8001, ...e }));
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.SSG, { id: 7 }));
      await service.execHistory(buildMap(IOrderType.SSG));

      const ssgExpiry = orderDeliveryRepository.update.mock.calls.filter((c: any[]) => 'expireAt' in c[1]);
      expect(ssgExpiry).toHaveLength(0);
    });
  });

  /**
   * D3-55 후속 2 — 변형 lease(mutationClaimedAt).
   *
   * tip 은 새 행이므로 INSERT 자체가 원자적 lease 획득이다(CAS 불필요).
   * issue()/발송(외부 통신) 동안 폐기·외부취소·발송배치가 tip 에 진입하지 못하게 하고,
   * 종료(정상/실패) 시 owner guard 조건부로 해제한다. 쓰기는 fencing(WHERE mutationClaimedAt=:my)
   * 조건부라 stale 강탈 후 깨어난 좀비는 affected=0 으로 아무것도 덮지 않는다.
   */
  describe('D3-55 후속 2 — 변형 lease (tip INSERT 획득 / finally 해제 / fencing)', () => {
    const releaseCalls = () =>
      orderDeliveryRepository.update.mock.calls.filter(
        (c: any[]) => c[1] && 'mutationClaimedAt' in c[1] && c[1].mutationClaimedAt === null,
      );

    it('19) tip INSERT 에 lease 세팅 + 성공 경로 finally 에서 owner-guarded 해제', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));

      await service.execHistory(buildMap(IOrderType.GENERAL));

      // INSERT 시 획득
      const inserted = orderDeliveryRepository.save.mock.calls[0][0];
      expect(inserted.mutationClaimedAt).toBeInstanceOf(Date);

      // finally 해제: WHERE { id, mutationClaimedAt: 내토큰 } → SET { mutationClaimedAt: null }
      const releases = releaseCalls();
      expect(releases).toHaveLength(1);
      expect(releases[0][0]).toEqual({ id: 8001, mutationClaimedAt: inserted.mutationClaimedAt });
      expect(releases[0][1]).toEqual({ mutationClaimedAt: null });
    });

    it('20) 발송 실패(throw) 경로에서도 finally 해제가 실행된다', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));
      deliveryBatchService.csResendAsSms.mockRejectedValue(new Error('MMS gateway down'));

      await expect(service.execHistory(buildMap(IOrderType.GENERAL))).rejects.toThrow(/발송에 실패했습니다/);

      expect(releaseCalls()).toHaveLength(1);
    });

    it('21) fencing: lease 상실(affected=0)이면 유효기간/발송결과를 덮지 않고 로그만 남긴 채 진행', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));
      // stale 강탈 시나리오: 모든 update 가 affected=0 (남이 lease 를 가져감)
      orderDeliveryRepository.update.mockResolvedValue({ affected: 0 });

      // throw 없이 완료(발송 자체는 성공) — 좀비가 된 재발행은 덮어쓰기만 포기한다
      await service.execHistory(buildMap(IOrderType.GENERAL));

      const lostLogs = (service.logger.error as jest.Mock).mock.calls.filter((c: any[]) =>
        String(c[0]).includes('변형 lease 상실'),
      );
      expect(lostLogs.length).toBeGreaterThanOrEqual(2); // 유효기간 + 발송결과 둘 다 스킵
      // history 는 여전히 기록된다(사실 기록)
      expect(orderHistoryRepository.save).toHaveBeenCalled();
    });
  });
});
