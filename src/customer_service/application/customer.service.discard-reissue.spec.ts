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

    /**
     * 리뷰 HIGH: reverseDiscard 는 CAS(WHERE coupon_status=CANCEL) 라 affected=0 으로 조용히
     * 실패할 수 있다. caller 는 이 boolean 으로 "폐기를 취소했습니다. 다시 시도해 주세요"(복구됨)와
     * "운영팀에 문의"(복구 실패)를 가른다. 반환값이 affected 에서 실제로 파생되지 않고 상수 true 면
     * 복구 실패가 성공으로 보고되어 caller 의 분기(3-1)가 통째로 死문이 된다.
     */
    it('CAS 결과를 boolean 으로 반환한다 — affected=0 이면 false (복구 실패를 caller 가 알아야 한다)', async () => {
      const execute = jest.fn();
      const where = jest.fn().mockReturnValue({ execute });
      const set = jest.fn().mockReturnValue({ where });
      const update = jest.fn().mockReturnValue({ set });
      jest.spyOn(orderDeliveryRepository, 'createQueryBuilder').mockReturnValue({ update } as any);

      execute.mockResolvedValueOnce({ affected: 1 });
      await expect((service as any).reverseDiscard(99, OrderDeliveryCouponStatus.NOT_USED)).resolves.toBe(true);

      // CAS 불일치(이미 다른 액터가 상태를 바꿈) → 고객 쿠폰이 폐기된 채로 남아 있다
      execute.mockResolvedValueOnce({ affected: 0 });
      await expect((service as any).reverseDiscard(99, OrderDeliveryCouponStatus.NOT_USED)).resolves.toBe(false);

      // 드라이버가 affected 를 안 주는 경우도 성공으로 오인하지 않는다
      execute.mockResolvedValueOnce({});
      await expect((service as any).reverseDiscard(99, OrderDeliveryCouponStatus.NOT_USED)).resolves.toBe(false);
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

    /**
     * ★ 순서가 종전(reverseDiscard → softDelete)과 반대로 바뀌었다 (리뷰 CRITICAL).
     *
     * 종전 순서는 중간 중단·softDelete 실패 시 "원본 복구 + 살아있는 tip" 을 남긴다.
     * 그 tip 은 status=WAIT / barCode=NULL / claimed_at=NULL 이고 finally 가 lease 를 해제하므로
     * claimWaitDeliveries 를 전부 통과한다 → 배치가 **새 PIN 을 발급해 발송**한다.
     * SSG 선차감은 이미 역복원된 뒤라 **미차감 발급**(직접 자금 손실) + 고객 쿠폰 2장이 된다.
     *
     * 새 순서는 중단 시 남는 상태가 "둘 다 폐기"(무해·복구가능)다.
     * 그리고 softDelete 실패를 삼켜도 안전하도록, 그 앞에서 status/couponStatus 를 CANCEL 로
     * 전이(fenced)해 배치 픽업을 확실히 차단한다.
     */
    it('3) issue 실패 + RESTORED → 선차감 역복원 + tip 무력화(먼저) + reverseDiscard(나중)', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.SSG, { id: 7 }));
      partnerCompanyExternService.issue.mockRejectedValue(new Error('issue boom'));
      deliveryBatchService.reverseSsgReissueDeduct.mockResolvedValue(SsgRefundOutcome.RESTORED);
      const reverseDiscardSpy = jest.spyOn(service as any, 'reverseDiscard').mockResolvedValue(true);

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow();

      expect(deliveryBatchService.reverseSsgReissueDeduct).toHaveBeenCalledWith(
        expect.anything(),
        7,
        PRICE,
        ORDER_ID,
        'ULID1',
      );

      // tip 무력화: fenced update 로 status/couponStatus 를 CANCEL 전이 → 배치가 못 집는다
      const killCall = (orderDeliveryRepository.update.mock.calls as unknown as any[][]).find(
        (c) => c[1] && c[1].couponStatus === OrderDeliveryCouponStatus.CANCEL,
      );
      expect(killCall).toBeDefined();
      expect(killCall![0]).toEqual({ id: expect.anything(), mutationClaimedAt: expect.any(Date) });
      expect(killCall![1].status).toBe(IOrderDeliveryStatus.CANCEL);

      expect(reverseDiscardSpy).toHaveBeenCalledWith(7001, OrderDeliveryCouponStatus.NOT_USED);
      expect(orderDeliveryRepository.softDelete).toHaveBeenCalled();

      // 무력화 → softDelete → reverseDiscard 순
      const killOrder =
        orderDeliveryRepository.update.mock.invocationCallOrder[
          (orderDeliveryRepository.update.mock.calls as unknown as any[][]).findIndex(
            (c) => c[1] && c[1].couponStatus === OrderDeliveryCouponStatus.CANCEL,
          )
        ];
      const softDeleteOrder = orderDeliveryRepository.softDelete.mock.invocationCallOrder[0];
      const reverseOrder = reverseDiscardSpy.mock.invocationCallOrder[0];
      expect(killOrder).toBeLessThan(softDeleteOrder);
      expect(softDeleteOrder).toBeLessThan(reverseOrder);
    });

    /**
     * 리뷰 HIGH: reverseDiscard 는 CAS(WHERE coupon_status=CANCEL) 라 affected=0 으로 조용히
     * 실패할 수 있다. 그런데도 "폐기를 취소했습니다. 다시 시도해 주세요" 라고 말하면, 운영자는
     * 복구된 줄 알고 재시도하지만 원본이 폐기 상태라 terminal 가드에 걸린다 —
     * 고객은 쿠폰을 잃었는데 CS 는 이유를 모른다.
     */
    it('3-1) issue 실패 + RESTORED + reverseDiscard 실패 → "다시 시도" 유도 금지, 운영팀 문의 안내', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.SSG, { id: 7 }));
      partnerCompanyExternService.issue.mockRejectedValue(new Error('issue boom'));
      deliveryBatchService.reverseSsgReissueDeduct.mockResolvedValue(SsgRefundOutcome.RESTORED);
      jest.spyOn(service as any, 'reverseDiscard').mockResolvedValue(false); // CAS 불일치

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow(/운영팀에 문의/);
      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.not.toThrow(/다시 시도해 주세요/);
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

    /**
     * ★ 종전 계약("로그만 남기고 진행")을 뒤집었다 (리뷰 HIGH).
     *
     * fencing affected=0 = lease 를 빼앗겼다 = **다른 폐기/취소가 지금 이 tip 을 죽이고 있다**.
     * 그런데도 발송을 강행하면, 협력사에서 취소·환불된 핀을 고객에게 문자로 배달한다 —
     * 이 작업 전체가 막으려던 바로 그 사고다. 아직 발송 전이므로 중단이 가장 싸다.
     */
    it('21) fencing: 유효기간 기록이 lease 상실(affected=0)이면 발송하지 않고 중단한다', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));
      // stale 강탈 시나리오: fenced update 가 affected=0 (남이 lease 를 가져감)
      orderDeliveryRepository.update.mockResolvedValue({ affected: 0 });

      await expect(service.execHistory(buildMap(IOrderType.GENERAL))).rejects.toThrow(/다른 작업이 이 발송 건을 선점/);

      // 발송 자체가 일어나면 안 된다 — 죽은 핀 배달 차단
      expect(deliveryBatchService.csResendAsMms).not.toHaveBeenCalled();
      expect(deliveryBatchService.csResendAsSms).not.toHaveBeenCalled();
      expect(deliveryBatchService.csResendAsAlimTalk).not.toHaveBeenCalled();

      const lostLogs = (service.logger.error as jest.Mock).mock.calls.filter((c: any[]) =>
        String(c[0]).includes('변형 lease 상실'),
      );
      expect(lostLogs.length).toBeGreaterThanOrEqual(1);
    });

    /**
     * ★ wallet 승계는 유효기간 fencing **앞**이어야 한다 (리뷰 HIGH).
     *
     * fencing 이 lease 상실로 throw 하면 우리는 발송하지 않지만 tip 은 사라지지 않는다.
     * status=WAIT + barCode(협력사에서 이미 발급·과금) 로 남아, 탈취자가 배치면 배치가 그대로
     * 고객에게 발송한다. 그 시점에 wallet 이 미승계면 allocation_line/attempt 가 원본을 가리켜
     * 이후 그 쿠폰을 폐기해도 환불이 drift abort 된다 — 고객은 쿠폰을 잃고 환불도 못 받는다.
     *
     * (단 barCode 검사보다는 뒤여야 한다. 그 경로는 unwind 가 tip 을 softDelete 하므로 wallet 을
     *  옮겨 두면 원본의 환불 근거가 사라진다.)
     */
    it('26) fencing 으로 중단하더라도 wallet 승계는 이미 끝나 있다 (배치가 tip 을 발송할 수 있으므로)', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));
      const carry = jest.spyOn(service as any, 'carryWalletOwnershipToReissuedDelivery').mockResolvedValue(undefined);
      orderDeliveryRepository.update.mockResolvedValue({ affected: 0 });

      await expect(service.execHistory(buildMap(IOrderType.GENERAL))).rejects.toThrow(/다른 작업이 이 발송 건을 선점/);

      expect(carry).toHaveBeenCalled();
    });

    /**
     * SSG 는 유효기간 fenced update 분기를 타지 않으므로(issue() 가 expireAt 을 채움) 검사 지점이
     * 없었다. 발송 직전 lease 소유 재확인이 그 공백을 메운다.
     */
    it('22) SSG: 발송 직전 lease 소유 재확인 — 상실했으면 발송하지 않고 중단', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.findOne
        .mockResolvedValueOnce(buildFullDelivery(IOrderType.SSG, { id: 7 })) // fullDelivery 로드
        .mockResolvedValue(null); // isMutationLeaseOwned → 내 lease 아님

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow(/다른 작업이 이 발송 건을 선점/);

      expect(deliveryBatchService.csResendAsMms).not.toHaveBeenCalled();
    });

    /**
     * 발송 후 fencing 실패는 되돌릴 수 없다(문자는 이미 나갔다). 그대로 두면 tip 이 WAIT 로 남아
     * 배치가 같은 핀으로 재발송한다(고객 문자 2통). 최소한 status 를 WAIT 에서 떼어내야 한다.
     */
    /**
     * ★ pre-issue catch 의 lease 해제는 unwind **뒤**여야 한다 (리뷰 CONFIRMED).
     *
     * 먼저 반납하면 그 창에서 tip 은 status=WAIT / claimed_at=NULL / lease 없음 /
     * coupon_status=NOT_USED / soft-delete 전 — claimWaitDeliveries 의 모든 조건을 통과한다.
     * 배치가 집어 PIN 을 발급·발송하고, 뒤이어 unwind 가 원본 폐기를 되돌리면
     * **살아있는 쿠폰 2장**(원본 + 배치가 발송한 tip)이 된다. SSG 선차감은 이미 역복원된 뒤라
     * 미차감 발급까지 겹친다.
     *
     * 반대 순서(unwind → 해제)면 배치가 그 창을 볼 때 tip 은 이미 CANCEL + soft-delete 다.
     */
    it('24) pre-issue 실패: lease 해제가 unwind(tip 무력화·softDelete) 뒤에 일어난다', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      // pre-issue 경로 진입: save 는 성공하되 findOne 이 null → "새 발송 건 조회 실패"
      orderDeliveryRepository.save.mockResolvedValue({ id: 8001 });
      orderDeliveryRepository.findOne.mockResolvedValue(null);
      jest.spyOn(service as any, 'reverseDiscard').mockResolvedValue(true);

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow();

      // tip 무력화(fenced kill)와 lease 해제는 둘 다 update 로 나간다 — 호출 순서로 구분.
      // ★ 반드시 tip(id=8001) 로 한정할 것. execHistory 는 재발행 전에 execDiscard 를 실제로
      //   호출하고, 그 안에서 **원본**의 변형 lease 를 잡았다 푼다(해제도 mutationClaimedAt:null).
      //   id 로 좁히지 않으면 그 원본 해제를 tip 의 해제로 오인해 순서 검증이 무의미해진다.
      const TIP_ID = 8001;
      const calls = (orderDeliveryRepository.update.mock.calls as unknown as any[][]).map((c, i) => ({ c, i }));
      const killIdx = calls.find(
        ({ c }) => c[0]?.id === TIP_ID && c[1]?.couponStatus === OrderDeliveryCouponStatus.CANCEL,
      )?.i;
      const releaseIdx = calls.find(({ c }) => c[0]?.id === TIP_ID && c[1]?.mutationClaimedAt === null)?.i;

      expect(killIdx).toBeDefined(); // unwind 의 tip 무력화가 실제로 일어났고
      expect(releaseIdx).toBeDefined(); // tip 의 lease 해제도 일어났으며
      const killOrder = orderDeliveryRepository.update.mock.invocationCallOrder[killIdx!];
      const releaseOrder = orderDeliveryRepository.update.mock.invocationCallOrder[releaseIdx!];
      const softDeleteOrder = orderDeliveryRepository.softDelete.mock.invocationCallOrder[0];

      // 해제는 반드시 마지막 — 그 전에 tip 은 CANCEL 전이 + soft-delete 로 배치 픽업이 봉쇄돼야 한다
      expect(killOrder).toBeLessThan(releaseOrder);
      expect(softDeleteOrder).toBeLessThan(releaseOrder);
    });

    /**
     * ★ tip 무력화 실패(변형 lease 상실)면 원본 폐기를 되돌리면 안 된다 (리뷰 HIGH).
     *
     * kill 의 affected=0 은 "WHERE 의 lease 토큰이 안 맞는다" = 남이 이 tip 을 가져갔다는 뜻이다.
     * 그 tip 은 status=WAIT / coupon_status=NOT_USED 로 살아 있어 배치가 집어 PIN 을 발급·발송한다.
     * 여기서 원본 폐기까지 되돌리면 **살아있는 쿠폰이 2장**이 된다.
     *
     * 되돌리지 않으면 남는 상태는 "원본 폐기 + tip 발송" — 재발행이 배치를 경유해 완료된 것과
     * 같아 고객 피해가 없다. 따라서 폐기 역전은 tipNeutralized 를 전제로만 수행한다.
     */
    it('25) pre-issue 실패 + tip 무력화 실패(lease 상실): 원본 폐기를 되돌리지 않는다 (쿠폰 2장 방지)', async () => {
      setupSsgAcquired();
      setupExecDiscard();
      orderDeliveryRepository.save.mockResolvedValue({ id: 8001 });
      orderDeliveryRepository.findOne.mockResolvedValue(null);

      const reverseDiscard = jest.spyOn(service as any, 'reverseDiscard').mockResolvedValue(true);
      // tip(8001) 의 kill 만 affected=0 (lease 를 뺏김). 나머지 update 는 정상.
      const baseUpdate = orderDeliveryRepository.update.getMockImplementation();
      orderDeliveryRepository.update.mockImplementation(async (criteria: any, set: any) => {
        if (criteria?.id === 8001 && set?.couponStatus === OrderDeliveryCouponStatus.CANCEL) {
          return { affected: 0 };
        }
        return baseUpdate ? await baseUpdate(criteria, set) : { affected: 1 };
      });

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow();

      // 되돌렸다면 원본 쿠폰이 살아나 tip 과 함께 2장이 된다
      expect(reverseDiscard).not.toHaveBeenCalled();
    });

    /**
     * ★ 발송 후 lease 상실은 **성공이 아니다** (리뷰 CRITICAL).
     *
     * 종전에는 fallback 쓰기만 하고 정상 return 했다 → CS 화면에 "재발행 완료" 로 뜬다.
     * 그러나 lease 를 빼앗겼다는 건 다른 폐기/취소가 그 핀을 죽이고 있(었)다는 뜻이고,
     * 문자는 이미 나갔다. 고객은 취소·환불된 죽은 핀을 들고 전화하는데 CS 이력은 정상 발행이다.
     * 외부 API resendOrder 는 같은 상황에서 3010 을 던진다 — 내부만 성공을 주장할 이유가 없다.
     *
     * 단 history 는 남긴 뒤 던져야 한다. 발급·발송된 PIN 을 추적할 유일한 수단이다.
     */
    it('23) 발송 후 fencing 실패 → fallback 쓰기 + history 기록 후 throw (성공 반환 금지)', async () => {
      setupExecDiscard();
      orderDeliveryRepository.findOne.mockResolvedValue(buildFullDelivery(IOrderType.GENERAL, null));
      // 유효기간 update 는 성공(=lease 보유), 발송결과 fenced update 만 affected=0
      orderDeliveryRepository.update
        .mockResolvedValueOnce({ affected: 1 }) // 유효기간
        .mockResolvedValueOnce({ affected: 0 }) // 발송결과 (fenced) — lease 상실
        .mockResolvedValue({ affected: 1 }); // fallback + 해제

      await expect(service.execHistory(buildMap(IOrderType.GENERAL))).rejects.toThrow(/다른 처리가 이 발송 건을 선점/);

      const fallback = (orderDeliveryRepository.update.mock.calls as unknown as any[][]).find(
        (c) => c[0] && c[0].status === IOrderDeliveryStatus.WAIT,
      );
      expect(fallback).toBeDefined();
      // lease 가 아니라 status=WAIT 로 소유권을 좁힌다 — 배치가 이미 집어갔으면 affected=0 이라 안 덮는다
      expect(fallback![0]).toEqual({ id: expect.anything(), status: IOrderDeliveryStatus.WAIT });
      expect(fallback![1]).toHaveProperty('status');
      expect(fallback![1]).toHaveProperty('actualSendAt');

      // throw 하더라도 이력은 남아야 한다 — 고객이 받은 PIN 을 CS 가 조회할 유일한 수단
      expect(orderHistoryRepository.save).toHaveBeenCalled();
    });
  });
});
