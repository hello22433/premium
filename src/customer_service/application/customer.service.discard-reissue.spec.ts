import { BadRequestException } from '@nestjs/common';
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
 *  - issue 실패 + RESTORED(미등록 확정): 선차감 역복원 + softDelete + reverseDiscard(없던 일로).
 *  - issue 실패 + SKIPPED_CONFIRMED(등록 확정): 폐기 유지(reverseDiscard 미호출).
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
  const buildFullDelivery = (orderType: IOrderType, ssgEvent: any) =>
    ({
      id: 8001,
      barCode: orderType === IOrderType.SSG ? 'PIN123' : 'G1',
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

  beforeEach(() => {
    deliveryBatchService = {
      selectAndDeductSsgEventForReissue: jest.fn(),
      reverseSsgReissueDeduct: jest.fn(),
      csResendAsSms: jest.fn().mockResolvedValue(IOrderDeliveryStatus.COMPLETE),
      csResendAsMms: jest.fn().mockResolvedValue(undefined),
      csResendAsAlimTalk: jest.fn().mockResolvedValue(IOrderDeliveryStatus.COMPLETE),
      csResendAsEmail: jest.fn().mockResolvedValue(undefined),
    };
    partnerCompanyExternService = {
      issue: jest.fn().mockResolvedValue(undefined),
    };
    orderDeliveryRepository = {
      save: jest.fn().mockImplementation(async (e: any) => ({ id: 8001, ...e })),
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

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow(
        /발급 가능한 행사가 없습니다/,
      );

      expect(execDiscardSpy).not.toHaveBeenCalled();
    });

    it('2) 정상: 새로 확보한 행사 id 로 newDelivery.ssgEventId 세팅', async () => {
      deliveryBatchService.selectAndDeductSsgEventForReissue.mockResolvedValue({
        event: { id: 7 },
        resendDeductionId: 'ULID1',
      });
      jest.spyOn(service as any, 'execDiscard').mockResolvedValue({
        orderDelivery: buildDiscardedDelivery(),
        beforeChange: OrderDeliveryCouponStatus.NOT_USED,
        refundStatus: 'SKIPPED',
      });
      orderDeliveryRepository.findOne.mockResolvedValue(
        buildFullDelivery(IOrderType.SSG, { id: 7 }),
      );

      await service.execHistory(buildMap(IOrderType.SSG));

      expect(partnerCompanyExternService.issue).toHaveBeenCalled();
      // 첫 save 에 넘긴 newDelivery 의 ssgEventId 검증
      const firstSavedEntity = orderDeliveryRepository.save.mock.calls[0][0];
      expect(firstSavedEntity.ssgEventId).toBe(7);
    });

    it('3) issue 실패 + RESTORED → 선차감 역복원 + softDelete + reverseDiscard', async () => {
      deliveryBatchService.selectAndDeductSsgEventForReissue.mockResolvedValue({
        event: { id: 7 },
        resendDeductionId: 'ULID1',
      });
      jest.spyOn(service as any, 'execDiscard').mockResolvedValue({
        orderDelivery: buildDiscardedDelivery(),
        beforeChange: OrderDeliveryCouponStatus.NOT_USED,
        refundStatus: 'SKIPPED',
      });
      orderDeliveryRepository.findOne.mockResolvedValue(
        buildFullDelivery(IOrderType.SSG, { id: 7 }),
      );
      partnerCompanyExternService.issue.mockRejectedValue(new Error('issue boom'));
      deliveryBatchService.reverseSsgReissueDeduct.mockResolvedValue(SsgRefundOutcome.RESTORED);
      const reverseDiscardSpy = jest
        .spyOn(service as any, 'reverseDiscard')
        .mockResolvedValue(undefined);

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

    it('4) issue 실패 + SKIPPED_CONFIRMED → 폐기 유지(reverseDiscard 미호출)', async () => {
      deliveryBatchService.selectAndDeductSsgEventForReissue.mockResolvedValue({
        event: { id: 7 },
        resendDeductionId: 'ULID1',
      });
      jest.spyOn(service as any, 'execDiscard').mockResolvedValue({
        orderDelivery: buildDiscardedDelivery(),
        beforeChange: OrderDeliveryCouponStatus.NOT_USED,
        refundStatus: 'SKIPPED',
      });
      orderDeliveryRepository.findOne.mockResolvedValue(
        buildFullDelivery(IOrderType.SSG, { id: 7 }),
      );
      partnerCompanyExternService.issue.mockRejectedValue(new Error('issue boom'));
      deliveryBatchService.reverseSsgReissueDeduct.mockResolvedValue(
        SsgRefundOutcome.SKIPPED_CONFIRMED,
      );
      const reverseDiscardSpy = jest
        .spyOn(service as any, 'reverseDiscard')
        .mockResolvedValue(undefined);

      await expect(service.execHistory(buildMap(IOrderType.SSG))).rejects.toThrow();

      expect(reverseDiscardSpy).not.toHaveBeenCalled();
    });

    it('5) 일반쿠폰: SSG select/deduct 미호출', async () => {
      jest.spyOn(service as any, 'execDiscard').mockResolvedValue({
        orderDelivery: buildDiscardedDelivery(),
        beforeChange: OrderDeliveryCouponStatus.NOT_USED,
        refundStatus: 'SKIPPED',
      });
      orderDeliveryRepository.findOne.mockResolvedValue(
        buildFullDelivery(IOrderType.GENERAL, null),
      );

      await service.execHistory(buildMap(IOrderType.GENERAL));

      expect(deliveryBatchService.selectAndDeductSsgEventForReissue).not.toHaveBeenCalled();
      expect(partnerCompanyExternService.issue).toHaveBeenCalled();
    });
  });
});
