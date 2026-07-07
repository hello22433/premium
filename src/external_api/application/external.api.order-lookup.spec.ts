import { ExternalApiService } from './external.api.service';
import { ExternalApiException } from '../api/external.api.exception.filter';
import { ExternalCouponStatus, ExternalDeliveryStatus } from '../api/dto/external.api.response.dto';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { IOrderStatus } from '../../order/interface/order.status';

/**
 * getOrderStatusByExternalOrderId (reconcile 읽기) + assertExternalOrderIdIfRequired (강제).
 *
 * 핵심 검증:
 *  - found=false → 주문 미착지(호출자 grace 후 FAILED 판정 근거)
 *  - deliveryStatus 정직성(#3): 완료 전이 전(actualSendAt 미백필)이라도 발송 성공 이력이 있으면 SUCCESS
 *  - 명시적 실패(FAIL) 는 이력 조회 없이 FAIL (short-circuit)
 *  - requireExternalOrderId 앱은 externalOrderId 누락 시 2001
 */
describe('ExternalApiService — externalOrderId reconcile 조회 / 강제', () => {
  const account = { user: { id: 1 } } as any;
  const ctx = (requireExternalOrderId = false) => ({ apiApp: { id: '1', requireExternalOrderId } }) as any;

  const makeSut = (opts: { order?: any; orderDelivery?: any; sendHistory?: any } = {}) => {
    const sut: any = Object.create(ExternalApiService.prototype);
    sut.mappingResolver = {
      findExistingOrderByExternalOrderId: jest.fn().mockResolvedValue(opts.order ?? null),
    };
    sut.orderDeliveryRepository = { findOne: jest.fn().mockResolvedValue(opts.orderDelivery ?? null) };
    sut.deliverySendHistoryRepository = { findOne: jest.fn().mockResolvedValue(opts.sendHistory ?? null) };
    return sut;
  };

  const delivery = (over: Partial<any> = {}) => ({
    id: 42,
    status: IOrderDeliveryStatus.WAIT,
    actualSendAt: null,
    barCode: '4161150509230215',
    personalCode: null,
    couponStatus: null,
    externalTrId: 'TR_1579',
    expireAt: null, // resolveValidDates 는 expireAt null 이면 partnerCompany 접근 없이 undefined 반환
    ...over,
  });

  it('externalOrderId 공백 → 2001', async () => {
    const sut = makeSut();
    await expect(sut.getOrderStatusByExternalOrderId(account, ctx(), '  ')).rejects.toBeInstanceOf(
      ExternalApiException,
    );
  });

  it('주문 없음 → found=false (delivery 조회 안 함)', async () => {
    const sut = makeSut({ order: null });
    const res = await sut.getOrderStatusByExternalOrderId(account, ctx(), 'req-1');
    expect(res.data).toEqual({ found: false });
    expect(sut.orderDeliveryRepository.findOne).not.toHaveBeenCalled();
  });

  it('정상 완료(actualSendAt 있음) → found=true, deliveryStatus SUCCESS, couponStatus ISSUED', async () => {
    const sut = makeSut({
      order: { id: 1579, status: IOrderStatus.DELIVERY_COMPLETE },
      orderDelivery: delivery({ actualSendAt: new Date() }),
    });
    const res = await sut.getOrderStatusByExternalOrderId(account, ctx(), 'req-1');
    expect(res.data.found).toBe(true);
    expect(res.data.trId).toBe('TR_1579');
    expect(res.data.orderStatus).toBe(IOrderStatus.DELIVERY_COMPLETE);
    expect(res.data.deliveryStatus).toBe(ExternalDeliveryStatus.SUCCESS);
    expect(res.data.couponStatus).toBe(ExternalCouponStatus.ISSUED);
    expect(res.data.barCode).toBe('4161150509230215');
    // actualSendAt 있으면 이력 조회 불필요
    expect(sut.deliverySendHistoryRepository.findOne).not.toHaveBeenCalled();
  });

  it('크래시 윈도우(WAIT + actualSendAt null + 발송성공 이력) → SUCCESS (정직성 #3)', async () => {
    const sut = makeSut({
      order: { id: 1579, status: IOrderStatus.DELIVERY_REQUEST },
      orderDelivery: delivery({ status: IOrderDeliveryStatus.WAIT, actualSendAt: null }),
      sendHistory: { id: 9, isSuccess: true },
    });
    const res = await sut.getOrderStatusByExternalOrderId(account, ctx(), 'req-1');
    expect(res.data.orderStatus).toBe(IOrderStatus.DELIVERY_REQUEST);
    expect(res.data.deliveryStatus).toBe(ExternalDeliveryStatus.SUCCESS);
    expect(sut.deliverySendHistoryRepository.findOne).toHaveBeenCalledWith({
      where: { orderDeliveryId: 42, isSuccess: true },
    });
  });

  it('미발송(WAIT + actualSendAt null + 이력 없음) → FAIL', async () => {
    const sut = makeSut({
      order: { id: 1579, status: IOrderStatus.DELIVERY_REQUEST },
      orderDelivery: delivery({ status: IOrderDeliveryStatus.WAIT, actualSendAt: null }),
      sendHistory: null,
    });
    const res = await sut.getOrderStatusByExternalOrderId(account, ctx(), 'req-1');
    expect(res.data.deliveryStatus).toBe(ExternalDeliveryStatus.FAIL);
  });

  it('명시적 실패(status FAIL) → FAIL, 이력 조회 short-circuit', async () => {
    const sut = makeSut({
      order: { id: 1579, status: IOrderStatus.DELIVERY_CANCEL },
      orderDelivery: delivery({ status: IOrderDeliveryStatus.FAIL, actualSendAt: null }),
    });
    const res = await sut.getOrderStatusByExternalOrderId(account, ctx(), 'req-1');
    expect(res.data.deliveryStatus).toBe(ExternalDeliveryStatus.FAIL);
    expect(res.data.orderStatus).toBe(IOrderStatus.DELIVERY_CANCEL);
    expect(sut.deliverySendHistoryRepository.findOne).not.toHaveBeenCalled();
  });

  it('couponStatus=CANCEL → DISCARDED', async () => {
    const sut = makeSut({
      order: { id: 1579, status: IOrderStatus.DELIVERY_CANCEL },
      orderDelivery: delivery({ couponStatus: OrderDeliveryCouponStatus.CANCEL, status: IOrderDeliveryStatus.FAIL }),
    });
    const res = await sut.getOrderStatusByExternalOrderId(account, ctx(), 'req-1');
    expect(res.data.couponStatus).toBe(ExternalCouponStatus.DISCARDED);
  });

  describe('assertExternalOrderIdIfRequired', () => {
    it('required + 누락 → 2001', () => {
      const sut = makeSut();
      expect(() => sut.assertExternalOrderIdIfRequired(ctx(true), undefined)).toThrow(ExternalApiException);
      expect(() => sut.assertExternalOrderIdIfRequired(ctx(true), '   ')).toThrow(ExternalApiException);
    });

    it('required + 존재 → 통과', () => {
      const sut = makeSut();
      expect(() => sut.assertExternalOrderIdIfRequired(ctx(true), 'req-1')).not.toThrow();
    });

    it('non-required + 누락 → 통과(기존 앱 무영향)', () => {
      const sut = makeSut();
      expect(() => sut.assertExternalOrderIdIfRequired(ctx(false), undefined)).not.toThrow();
    });
  });
});
