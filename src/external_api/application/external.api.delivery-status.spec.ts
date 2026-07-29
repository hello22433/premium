import { ExternalApiService } from './external.api.service';
import { ExternalCouponStatus, ExternalDeliveryStatus } from '../api/dto/external.api.response.dto';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';

// 외부 API 상태 조회 응답 계약 고정.
// getOrderStatus / getSsgOrderStatus 가 deliveryStatus(SUCCESS|FAIL) 를 항상 포함하고,
// toExternalDeliveryStatus 매핑(actualSendAt 유무 + 명시적 FAIL/FAIL_SMS)이 흔들리지 않도록 잠근다.

const account = {
  user: { id: 42, companyId: null },
} as unknown as ExternalApiAccountEntity;

const ctx = {
  apiApp: { id: '1' },
  apiCredential: { id: '1' },
  billingUserId: 42,
  externalCustomerId: null,
} as any;

function makeOrderDelivery(over: {
  status: IOrderDeliveryStatus;
  actualSendAt?: Date | null;
  couponStatus?: OrderDeliveryCouponStatus;
  personalCode?: string;
  productPrice?: number; // live 카탈로그가(가변). 미지정 시 sendAmount 와 동일.
  sendAmount?: number; // 주문시점 박제가.
}): OrderDeliveryEntity {
  const sendAmount = over.sendAmount ?? 4500;
  return {
    id: 55,
    externalTrId: 'TR-DELIVERY-STATUS',
    status: over.status,
    actualSendAt: over.actualSendAt ?? null,
    couponStatus: over.couponStatus ?? OrderDeliveryCouponStatus.NOT_USED,
    personalCode: over.personalCode,
    barCode: '8801234567890',
    expireAt: null,
    sendRequestAt: new Date('2026-06-22T00:00:00.000Z'),
    orderProductMapping: {
      product: { price: over.productPrice ?? sendAmount, partnerCompany: { validityStartsNextDay: true } },
      order: { sendAmount, settleAmount: 4500 },
    },
  } as unknown as OrderDeliveryEntity;
}

function makeService(orderDelivery: OrderDeliveryEntity) {
  const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
  // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
  (svc as any).cutoverGuard = {
    assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
    assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
    isCutover: jest.fn().mockResolvedValue(false),
    splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
  };
  (svc as any).findOrderDeliveryByTrId = jest.fn(async () => orderDelivery);
  return svc;
}

describe('ExternalApiService 발송 결과(deliveryStatus) 응답 계약', () => {
  // [status, actualSendAt, 기대값]
  const cases: Array<[string, IOrderDeliveryStatus, Date | null, ExternalDeliveryStatus]> = [
    [
      '발송 성공(COMPLETE + actualSendAt) → SUCCESS',
      IOrderDeliveryStatus.COMPLETE,
      new Date(),
      ExternalDeliveryStatus.SUCCESS,
    ],
    ['발송 실패(FAIL) → FAIL', IOrderDeliveryStatus.FAIL, null, ExternalDeliveryStatus.FAIL],
    ['알림톡불가 SMS 실패(FAIL_SMS) → FAIL', IOrderDeliveryStatus.FAIL_SMS, null, ExternalDeliveryStatus.FAIL],
    ['미발송(WAIT, actualSendAt 없음) → FAIL', IOrderDeliveryStatus.WAIT, null, ExternalDeliveryStatus.FAIL],
    [
      '폐기됐지만 이전 발송 성공(CANCEL + actualSendAt) → SUCCESS',
      IOrderDeliveryStatus.CANCEL,
      new Date(),
      ExternalDeliveryStatus.SUCCESS,
    ],
  ];

  it.each(cases)('getOrderStatus: %s', async (_label, status, actualSendAt, expected) => {
    const orderDelivery = makeOrderDelivery({ status, actualSendAt });
    const svc = makeService(orderDelivery);

    const res = await svc.getOrderStatus(account, 'TR-DELIVERY-STATUS', ctx);

    expect(res.data).toHaveProperty('deliveryStatus');
    expect(res.data!.deliveryStatus).toBe(expected);
  });

  it('명시적 FAIL_SMS 는 actualSendAt 이 있어도 FAIL (실패 상태 우선)', async () => {
    const orderDelivery = makeOrderDelivery({
      status: IOrderDeliveryStatus.FAIL_SMS,
      actualSendAt: new Date(),
    });
    const svc = makeService(orderDelivery);

    const res = await svc.getOrderStatus(account, 'TR-DELIVERY-STATUS', ctx);

    expect(res.data!.deliveryStatus).toBe(ExternalDeliveryStatus.FAIL);
  });

  it('getSsgOrderStatus 도 deliveryStatus 와 personalCode 를 함께 반환한다', async () => {
    const orderDelivery = makeOrderDelivery({
      status: IOrderDeliveryStatus.COMPLETE,
      actualSendAt: new Date(),
      personalCode: '1234567890',
    });
    const svc = makeService(orderDelivery);

    const res = await svc.getSsgOrderStatus(account, 'TR-DELIVERY-STATUS', ctx);

    expect(res.data!.deliveryStatus).toBe(ExternalDeliveryStatus.SUCCESS);
    expect(res.data!.personalCode).toBe('1234567890');
  });

  it('폐기(CANCEL) 쿠폰은 couponStatus=DISCARDED 와 deliveryStatus=SUCCESS 가 공존한다', async () => {
    const orderDelivery = makeOrderDelivery({
      status: IOrderDeliveryStatus.CANCEL,
      actualSendAt: new Date(),
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
    });
    const svc = makeService(orderDelivery);

    const res = await svc.getOrderStatus(account, 'TR-DELIVERY-STATUS', ctx);

    expect(res.data!.couponStatus).toBe(ExternalCouponStatus.DISCARDED);
    expect(res.data!.deliveryStatus).toBe(ExternalDeliveryStatus.SUCCESS);
  });
});

// D3-53: 응답 price 소스 고정 회귀.
// getOrderStatus 가 과거엔 live product.price(가변)를 읽어, 주문 후 상품가가 바뀌면
// 생성응답(sendAmount)과 조회 price 가 달라졌다(파트너 대사 불일치). 주문시점 박제값으로 통일한 것을 잠근다.
describe('ExternalApiService getOrderStatus price 는 주문시점 박제값(sendAmount)을 반환', () => {
  it('상품가 변경으로 product.price(5000) ≠ sendAmount(2000) 여도 price=2000 (live 를 따라가지 않음)', async () => {
    // 손님은 2000 에 샀는데(sendAmount) 관리자가 카탈로그가를 5000 으로 올린 상황(product.price).
    const orderDelivery = makeOrderDelivery({
      status: IOrderDeliveryStatus.COMPLETE,
      actualSendAt: new Date(),
      productPrice: 5000,
      sendAmount: 2000,
    });
    const svc = makeService(orderDelivery);

    const res = await svc.getOrderStatus(account, 'TR-DELIVERY-STATUS', ctx);

    expect(res.data!.price).toBe(2000); // 영수증(박제)
    expect(res.data!.price).not.toBe(5000); // 매대 가격표(live)를 따라가지 않는다
  });

  it('일반 조회와 SSG 조회가 동일 소스(sendAmount)를 써 price 가 일치한다', async () => {
    const orderDelivery = makeOrderDelivery({
      status: IOrderDeliveryStatus.COMPLETE,
      actualSendAt: new Date(),
      productPrice: 5000,
      sendAmount: 2000,
    });
    const svc = makeService(orderDelivery);

    const general = await svc.getOrderStatus(account, 'TR-DELIVERY-STATUS', ctx);
    const ssg = await svc.getSsgOrderStatus(account, 'TR-DELIVERY-STATUS', ctx);

    expect(general.data!.price).toBe(ssg.data!.price); // 생성응답·SSG조회·일반조회 3자 일치
  });
});
