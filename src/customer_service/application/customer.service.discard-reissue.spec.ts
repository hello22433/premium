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
});
