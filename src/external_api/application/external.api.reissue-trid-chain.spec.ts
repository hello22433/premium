import { ExternalApiService } from './external.api.service';
import { ExternalCouponStatus } from '../api/dto/external.api.response.dto';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderStatus } from '../../order/interface/order.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';

// D3-55: 폐기 후 재발행 시 파트너 trId(externalTrId)는 폐기된 원본(root)에 남고, 새로 발급된
// 유효 delivery 는 externalTrId=null 이 된다. findOrderDeliveryByTrId 가 replacedFromId 체인의
// 살아있는 최신 delivery(tip)로 forward-hop 하는지, 상태조회 응답이 요청 trId 를 echo 하는지,
// 그리고 리뷰 지적(discardedAt 게이트/결정성/WAIT 레이스/reconcile trId 복구)이 잠기는지 검증.

const account = {
  user: { id: 42, companyId: null },
} as unknown as ExternalApiAccountEntity;

const ctx = {
  apiApp: { id: '1' },
  apiCredential: { id: '1' },
  billingUserId: 42,
  externalCustomerId: null,
} as any;

const MAPPING_ID = 900;
const DISCARDED_AT = new Date('2026-07-02T00:00:00.000Z');

function makeDelivery(over: {
  id: number;
  externalTrId?: string | null;
  couponStatus?: OrderDeliveryCouponStatus;
  replacedFromId?: number | string | null;
  barCode?: string;
  status?: IOrderDeliveryStatus;
  discardedAt?: Date | null;
  actualSendAt?: Date | null;
}): OrderDeliveryEntity {
  return {
    id: over.id,
    externalTrId: over.externalTrId ?? null,
    couponStatus: over.couponStatus ?? OrderDeliveryCouponStatus.NOT_USED,
    replacedFromId: over.replacedFromId ?? null,
    orderProductMappingId: MAPPING_ID,
    status: over.status ?? IOrderDeliveryStatus.COMPLETE,
    discardedAt: over.discardedAt ?? null,
    actualSendAt: over.actualSendAt === undefined ? new Date('2026-07-01T00:00:00.000Z') : over.actualSendAt,
    barCode: over.barCode ?? `PIN-${over.id}`,
    personalCode: null,
    expireAt: null,
    sendRequestAt: new Date('2026-07-01T00:00:00.000Z'),
    orderProductMapping: {
      product: { price: 5000, partnerCompany: { validityStartsNextDay: true }, isCancelable: true },
      order: {
        id: 7,
        apiAppId: '1',
        clientUserId: null,
        userId: 42,
        sendAmount: 5000,
        settleAmount: 5000,
        status: IOrderStatus.DELIVERY_COMPLETE,
      },
    },
  } as unknown as OrderDeliveryEntity;
}

function makeService(rows: OrderDeliveryEntity[]) {
  const findOne = jest.fn(async ({ where }: any) => {
    if (typeof where.externalTrId === 'string') {
      return rows.find((r) => r.externalTrId === where.externalTrId) ?? null;
    }
    if (where.id !== undefined) {
      return rows.find((r) => r.id === where.id) ?? null;
    }
    return null;
  });
  const find = jest.fn(async ({ where }: any) =>
    rows.filter((r) => r.orderProductMappingId === where.orderProductMappingId),
  );

  const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
  (svc as any).orderDeliveryRepository = { findOne, find };
  return { svc, findOne, find };
}

describe('D3-55 재발행 trId 체인 해소 (findOrderDeliveryByTrId / resolveActiveDelivery)', () => {
  it('재발행 없음: discardedAt=null 이면 자신이 tip, 형제 조회(find) 없이 반환', async () => {
    const root = makeDelivery({ id: 100, externalTrId: 'TR-1', couponStatus: OrderDeliveryCouponStatus.NOT_USED });
    const { svc, find } = makeService([root]);

    const resolved = await (svc as any).findOrderDeliveryByTrId(account, 'TR-1', ctx);

    expect(resolved.id).toBe(100);
    expect(find).not.toHaveBeenCalled(); // discardedAt=null 이면 추가 조회 스킵
  });

  it('재발행 없이 최종폐기: discardedAt 있으나 대체 행 없음 → root(=DISCARDED) 유지', async () => {
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      discardedAt: DISCARDED_AT,
    });
    const { svc } = makeService([root]);

    const resolved = await (svc as any).findOrderDeliveryByTrId(account, 'TR-1', ctx);

    expect(resolved.id).toBe(100);
    expect(resolved.couponStatus).toBe(OrderDeliveryCouponStatus.CANCEL);
  });

  it('재발행 1회: trId 는 폐기 root(100)에 있으나 살아있는 tip(101)으로 hop', async () => {
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      discardedAt: DISCARDED_AT,
    });
    const tip = makeDelivery({
      id: 101,
      externalTrId: null,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: 100,
      barCode: 'PIN-NEW',
    });
    const { svc } = makeService([root, tip]);

    const resolved = await (svc as any).findOrderDeliveryByTrId(account, 'TR-1', ctx);

    expect(resolved.id).toBe(101);
    expect(resolved.barCode).toBe('PIN-NEW');
  });

  it('재발행 2회(체인 100→101→102): tip=102 로 끝까지 추적', async () => {
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      discardedAt: DISCARDED_AT,
    });
    const mid = makeDelivery({
      id: 101,
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      replacedFromId: 100,
      discardedAt: DISCARDED_AT,
    });
    const tip = makeDelivery({
      id: 102,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: 101,
      barCode: 'PIN-102',
    });
    const { svc } = makeService([root, mid, tip]);

    const resolved = await (svc as any).findOrderDeliveryByTrId(account, 'TR-1', ctx);

    expect(resolved.id).toBe(102);
  });

  // ── 리뷰 finding 1: couponStatus 대신 discardedAt 게이트 (드리프트 내성) ──
  it('폐기 root 의 couponStatus 가 stale sync 로 CANCEL→USED 드리프트해도 tip 으로 hop', async () => {
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.USED, // CANCEL 이 아니라 드리프트된 상태
      discardedAt: DISCARDED_AT, // 폐기 이력은 남아있음(안정 마커)
    });
    const tip = makeDelivery({
      id: 101,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: 100,
    });
    const { svc } = makeService([root, tip]);

    const resolved = await (svc as any).findOrderDeliveryByTrId(account, 'TR-1', ctx);

    expect(resolved.id).toBe(101); // couponStatus 게이트였다면 root(USED)를 반환해 실패했을 것
  });

  // ── 리뷰 finding 3: 같은 원본을 가리키는 형제 복수 → 결정적으로 최신(max id) 선택 ──
  it('같은 replacedFromId 를 가진 형제가 둘이면 max id(최신)로 결정적 hop', async () => {
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      discardedAt: DISCARDED_AT,
    });
    const dupOld = makeDelivery({ id: 101, couponStatus: OrderDeliveryCouponStatus.NOT_USED, replacedFromId: 100 });
    const dupNew = makeDelivery({ id: 102, couponStatus: OrderDeliveryCouponStatus.NOT_USED, replacedFromId: 100 });
    const { svc } = makeService([root, dupOld, dupNew]);

    const resolved = await (svc as any).findOrderDeliveryByTrId(account, 'TR-1', ctx);

    expect(resolved.id).toBe(102); // 삽입 순서와 무관하게 max id
  });

  it('replacedFromId 가 string 으로 hydrate 돼도(Number 정규화) 정상 hop', async () => {
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      discardedAt: DISCARDED_AT,
    });
    const tip = makeDelivery({
      id: 101,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: '100', // bigint string hydrate 재현
    });
    const { svc } = makeService([root, tip]);

    const resolved = await (svc as any).findOrderDeliveryByTrId(account, 'TR-1', ctx);

    expect(resolved.id).toBe(101);
  });

  it('getOrderStatus: 재발행 후에도 응답 trId 는 요청값을 echo, couponStatus 는 tip 기준(ISSUED)', async () => {
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      discardedAt: DISCARDED_AT,
    });
    const tip = makeDelivery({
      id: 101,
      externalTrId: null, // tip 은 trId 미보유
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: 100,
      barCode: 'PIN-NEW',
    });
    const { svc } = makeService([root, tip]);

    const res = await svc.getOrderStatus(account, 'TR-1', ctx);

    expect(res.data!.trId).toBe('TR-1'); // tip.externalTrId(null) 이 아니라 요청 trId echo
    expect(res.data!.couponStatus).toBe(ExternalCouponStatus.ISSUED); // 살아있는 tip 기준
    expect(res.data!.barCode).toBe('PIN-NEW');
  });
});

// ── 리뷰 finding 2: 미발송(actualSendAt=null) 재발행 tip 에 대한 취소 환불 레이스 차단 ──
// (발송 신호는 status 가 아니라 actualSendAt — 정상 발송 쿠폰도 delivery.status 는 WAIT 로 남음)
describe('D3-55 재발행 미발송 tip 취소 가드', () => {
  it('cancelOrder: 미발송(actualSendAt=null) tip 은 3010 으로 거절(환불 레이스 차단)', async () => {
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      discardedAt: DISCARDED_AT,
    });
    const tip = makeDelivery({
      id: 101,
      externalTrId: null,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: 100,
      status: IOrderDeliveryStatus.WAIT,
      actualSendAt: null, // 재발행 발송 진행 중(미발송)
    });
    const { svc } = makeService([root, tip]);

    await expect(svc.cancelOrder(account, 'TR-1', ctx)).rejects.toMatchObject({ code: '3010' });
  });

  it('cancelOrder: 발송 완료된 재발행 tip(actualSendAt 있음)은 가드를 통과해 정상 취소 진행', async () => {
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      discardedAt: DISCARDED_AT,
    });
    const tip = makeDelivery({
      id: 101,
      externalTrId: null,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: 100,
      // actualSendAt 기본값(세팅됨) → 발송 완료된 살아있는 재발행 쿠폰
    });
    const svc = makeService([root, tip]).svc;
    // partnerCompany 취소/환불 경로를 스텁해 가드 통과만 검증(레이스 가드에 안 걸림).
    (svc as any).partnerCompanyExternService = { cancelByExternalApi: jest.fn(async () => undefined) };
    (svc as any).processCancelRefund = jest.fn(async () => undefined);

    const res = await svc.cancelOrder(account, 'TR-1', ctx);

    expect((svc as any).processCancelRefund).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('cancelOrder: 발송 실패(FAIL) 건은 3010(진행중) 아니라 3005(이미 실패)로 정확히 거절', async () => {
    // FAIL 원본: status=FAIL, actualSendAt=null, 재발행 아님(replacedFromId=null). 이미 실패 환불 완료 상태.
    const failed = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      status: IOrderDeliveryStatus.FAIL,
      actualSendAt: null,
    });
    const { svc } = makeService([failed]);

    // actualSendAt=null 이지만 재발행 tip 이 아니므로 3010 아닌 3005 여야 한다(무한 재시도 방지).
    await expect(svc.cancelOrder(account, 'TR-1', ctx)).rejects.toMatchObject({ code: '3005' });
  });
});

// ── 후속 1: getOrderStatusByExternalOrderId 는 상태=tip, trId=root 에서 복구 ──
describe('D3-55 후속: reconcile(getOrderStatusByExternalOrderId) trId 복구', () => {
  function makeReconcileService(tip: OrderDeliveryEntity, rootTrId: string | null) {
    const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
    (svc as any).mappingResolver = {
      findExistingOrderByExternalOrderId: jest.fn(async () => ({ id: 7, status: IOrderStatus.DELIVERY_COMPLETE })),
    };
    const findOne = jest.fn(async ({ where }: any) => {
      // trId 복구 조회: externalTrId 조건(FindOperator Not(IsNull())) 존재
      if (where.externalTrId !== undefined) {
        return rootTrId ? ({ externalTrId: rootTrId } as OrderDeliveryEntity) : null;
      }
      // tip 조회 (order 기준, id DESC)
      return tip;
    });
    (svc as any).orderDeliveryRepository = { findOne };
    return { svc, findOne };
  }

  it('재발행 후 tip.externalTrId=null 이어도 root 의 trId 를 복구해 반환', async () => {
    const tip = makeDelivery({
      id: 101,
      externalTrId: null,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      replacedFromId: 100,
    });
    const { svc, findOne } = makeReconcileService(tip, 'TR-1');

    const res = await svc.getOrderStatusByExternalOrderId(account, ctx, 'EXT-ORDER-1');

    expect(res.data!.found).toBe(true);
    expect(res.data!.trId).toBe('TR-1'); // tip null 이 아니라 root 의 trId 복구
    expect(findOne).toHaveBeenCalledTimes(2); // tip 조회 + trId 복구 조회
  });

  it('재발행 없음: tip 이 trId 를 가지면 추가 조회 없이 그대로 반환', async () => {
    const tip = makeDelivery({ id: 100, externalTrId: 'TR-1', couponStatus: OrderDeliveryCouponStatus.NOT_USED });
    const { svc, findOne } = makeReconcileService(tip, 'TR-1');

    const res = await svc.getOrderStatusByExternalOrderId(account, ctx, 'EXT-ORDER-1');

    expect(res.data!.trId).toBe('TR-1');
    expect(findOne).toHaveBeenCalledTimes(1); // tip 이 이미 trId 보유 → 복구 조회 스킵
  });
});
