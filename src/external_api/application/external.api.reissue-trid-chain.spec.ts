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
  barCode?: string | null;
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
    barCode: over.barCode === undefined ? `PIN-${over.id}` : over.barCode,
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

  // 변형 lease: createQueryBuilder 체인 = 획득(acquireMutationLease, 기본 성공), update = 해제(owner guard)
  const qb: any = {};
  for (const m of ['update', 'set', 'where', 'andWhere']) qb[m] = jest.fn(() => qb);
  qb.execute = jest.fn(async () => ({ affected: 1 }));
  const update = jest.fn(async () => ({ affected: 1 }));

  const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
  (svc as any).orderDeliveryRepository = { findOne, find, update, createQueryBuilder: jest.fn(() => qb) };
  (svc as any).logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
  return { svc, findOne, find, update, qb };
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

  it('getSsgOrderStatus: 재발행 후에도 응답 trId 는 요청값을 echo (getOrderStatus 와 대칭)', async () => {
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

    const res = await svc.getSsgOrderStatus(account, 'TR-1', ctx);

    expect(res.data!.trId).toBe('TR-1'); // tip.externalTrId(null) 아니라 요청 trId echo
    expect(res.data!.couponStatus).toBe(ExternalCouponStatus.ISSUED);
  });

  it('resendOrder: 재발행 trId 는 tip 으로 해소된다(폐기 root 로 갔다면 3005, tip(미발행)이면 3004)', async () => {
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL, // root 로 갔다면 여기서 3005
      discardedAt: DISCARDED_AT,
    });
    const tip = makeDelivery({
      id: 101,
      externalTrId: null,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED, // tip 은 살아있음
      replacedFromId: 100,
      barCode: null, // 미발행 → tip 으로 해소되면 3004
    });
    const { svc } = makeService([root, tip]);

    // 3004(발행된 쿠폰 없음) = tip(NOT_USED) 해소 증거. root 해소였다면 couponStatus CANCEL → 3005.
    await expect(svc.resendOrder(account, 'TR-1', ctx)).rejects.toMatchObject({ code: '3004' });
  });
});

// ── 살아있는 재발행 tip 은 파트너가 정상 취소 가능 (D3-55 핵심 가치) ──
// 참고: 재발행 발송 진행 중(actualSendAt=null) 창의 취소/환불 레이스는 재발행이 비원자적이라
// 발생 가능하나, status/actualSendAt 로 완벽 구분하려던 가드가 살아있는 FAIL_SMS tip 을 오차단하는 등
// 새 오류를 유발해 제거함(리뷰3). 알려진 제약으로 문서화, 근본 해법은 재발행 원자화(별도 작업).
describe('D3-55 살아있는 재발행 tip 취소', () => {
  it('cancelOrder: 살아있는 재발행 tip(발송완료) 은 tip 대상으로 정상 취소가 진행된다', async () => {
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
    // 취소/환불 부수효과는 스텁하고, tip(살아있는 행)이 취소 경로에 도달하는지만 검증.
    (svc as any).partnerCompanyExternService = { cancelByExternalApi: jest.fn(async () => undefined) };
    (svc as any).processCancelRefund = jest.fn(async () => undefined);

    const res = await svc.cancelOrder(account, 'TR-1', ctx);

    expect((svc as any).processCancelRefund).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('cancelOrder: 발송 실패(FAIL_SMS)했지만 PIN 발급된 살아있는 재발행 tip 도 정상 취소된다', async () => {
    // 리뷰(리뷰2 FAIL 가드 회귀 방지): 재발행 send 실패(FAIL_SMS)여도 PIN(barCode)은 발급됨·미환불 =
    // 살아있는 쿠폰. status=FAIL 로 막던 가드는 이걸 오차단했었다. 가드 제거 후엔 정상 취소/환불로 진행해야 한다.
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      discardedAt: DISCARDED_AT,
    });
    const tip = makeDelivery({
      id: 101,
      externalTrId: null,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED, // 아직 살아있음(터미널 아님)
      replacedFromId: 100,
      status: IOrderDeliveryStatus.FAIL_SMS, // 발송만 실패
      actualSendAt: null,
      barCode: 'PIN-NEW', // PIN 은 발급됨 → 취소로 회수 가능
    });
    const svc = makeService([root, tip]).svc;
    (svc as any).partnerCompanyExternService = { cancelByExternalApi: jest.fn(async () => undefined) };
    (svc as any).processCancelRefund = jest.fn(async () => undefined);

    const res = await svc.cancelOrder(account, 'TR-1', ctx);

    // 3005/3010 로 막히지 않고 취소·환불 경로에 도달해야 한다.
    expect((svc as any).processCancelRefund).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('cancelOrder: 이미 폐기/환불된 tip(couponStatus CANCEL)은 기존 터미널 가드로 3005', async () => {
    // 개념 정합: 폐기는 couponStatus 로 가드(환불상태로 가드하지 않음). 이미 폐기된 건은 3005.
    const root = makeDelivery({
      id: 100,
      externalTrId: 'TR-1',
      couponStatus: OrderDeliveryCouponStatus.CANCEL,
      discardedAt: DISCARDED_AT,
    });
    const tip = makeDelivery({
      id: 101,
      externalTrId: null,
      couponStatus: OrderDeliveryCouponStatus.CANCEL, // tip 도 이미 폐기됨
      replacedFromId: 100,
      discardedAt: DISCARDED_AT,
    });
    const { svc } = makeService([root, tip]);

    await expect(svc.cancelOrder(account, 'TR-1', ctx)).rejects.toMatchObject({ code: '3005' });
  });

  // ── D3-55 후속: 변형 lease — 재발행 진행중 창을 입구에서 차단 ──

  it('cancelOrder: 변형 lease 획득 실패(재발행 진행중) → 3010, 협력사 취소/환불 미진입', async () => {
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
      status: IOrderDeliveryStatus.WAIT, // 재발행 발급/발송 진행 중
      actualSendAt: null,
    });
    const { svc, qb } = makeService([root, tip]);
    qb.execute.mockResolvedValue({ affected: 0 }); // 재발행 tip 이 lease 보유 중 → CAS 실패
    (svc as any).partnerCompanyExternService = { cancelByExternalApi: jest.fn() };
    (svc as any).processCancelRefund = jest.fn();

    await expect(svc.cancelOrder(account, 'TR-1', ctx)).rejects.toMatchObject({ code: '3010' });

    expect((svc as any).partnerCompanyExternService.cancelByExternalApi).not.toHaveBeenCalled();
    expect((svc as any).processCancelRefund).not.toHaveBeenCalled();
  });

  it('cancelOrder: lease 획득 후 volatile 재조회 — 획득 직전 재발행이 채운 barCode 로 협력사 취소를 스킵하지 않는다', async () => {
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
      barCode: null, // resolve 시점 스냅샷: 아직 PIN 없음
      actualSendAt: null,
    });
    const { svc, qb } = makeService([root, tip]);
    // lease 획득 직전 재발행이 완료되어 barCode 가 채워진 상황 — 획득 시점에 행을 갱신
    qb.execute.mockImplementation(async () => {
      (tip as any).barCode = 'PIN-LATE';
      (tip as any).status = IOrderDeliveryStatus.COMPLETE;
      return { affected: 1 };
    });
    (svc as any).partnerCompanyExternService = { cancelByExternalApi: jest.fn(async () => undefined) };
    (svc as any).processCancelRefund = jest.fn(async () => undefined);

    await svc.cancelOrder(account, 'TR-1', ctx);

    // 재조회로 barCode 를 봤으므로 협력사 취소가 스킵되지 않는다 (스킵되면 갈락시아 살아있는 핀 + 환불 = 자금 사고)
    expect((svc as any).partnerCompanyExternService.cancelByExternalApi).toHaveBeenCalled();
  });

  it('cancelOrder: 성공/가드 거절 모두 owner-guarded 해제가 실행된다', async () => {
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
    });
    const { svc, update } = makeService([root, tip]);
    (svc as any).partnerCompanyExternService = { cancelByExternalApi: jest.fn(async () => undefined) };
    (svc as any).processCancelRefund = jest.fn(async () => undefined);

    await svc.cancelOrder(account, 'TR-1', ctx);

    expect(update).toHaveBeenCalledWith({ id: 101, mutationClaimedAt: expect.any(Date) }, { mutationClaimedAt: null });
  });

  it('cancelOrder: lease 획득 후 재조회가 비면(soft-delete 등) fail-closed 로 3010 — 협력사 취소 스킵 + 환불 강행 방지', async () => {
    // 리뷰 CONFIRMED: `if (fresh)` 로 열려 있으면, 재발행 실패로 unwindReissue 가 tip 을 softDelete 한 경우
    // 낡은 스냅샷(barCode=null)이 그대로 쓰여 협력사 취소가 스킵된 채 환불만 나간다 = 자금 사고.
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
      barCode: null, // 로드 시점 스냅샷: 아직 미발급
      actualSendAt: null,
    });
    const { svc, findOne } = makeService([root, tip]);
    // resolve 단계 조회는 정상, lease 획득 후 volatile 재조회만 null (행이 soft-delete 됨)
    const original = findOne.getMockImplementation()!;
    let call = 0;
    findOne.mockImplementation(async (opts: any) => {
      call += 1;
      if (call >= 3) return null; // root 조회 → tip 재로딩 → (3번째) volatile 재조회
      return original(opts);
    });
    (svc as any).partnerCompanyExternService = { cancelByExternalApi: jest.fn() };
    (svc as any).processCancelRefund = jest.fn();

    await expect(svc.cancelOrder(account, 'TR-1', ctx)).rejects.toMatchObject({ code: '3010' });

    expect((svc as any).partnerCompanyExternService.cancelByExternalApi).not.toHaveBeenCalled();
    expect((svc as any).processCancelRefund).not.toHaveBeenCalled(); // 환불 미진입
  });

  it('cancelOrder: 획득한 lease 를 메모리 엔티티에도 반영한다 — processCancelRefund 의 save(merge) 가 자기 lease 를 NULL 로 되돌리지 않도록', async () => {
    // 리뷰 CONFIRMED: findOrderDeliveryByTrId 는 full entity 로 로드하므로 mutationClaimedAt=null 이 메모리에 남는다.
    // acquireMutationLease 는 DB row 만 UPDATE → 동기화가 없으면 save(orderDelivery) 가 "메모리 null vs DB claimAt" 을
    // 변경으로 인식해 mutation_claimed_at=NULL 을 써버린다 = 환불 도중 자기 lease 자진 해제.
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
    });
    expect((tip as any).mutationClaimedAt ?? null).toBeNull(); // 로드 스냅샷은 null

    const { svc } = makeService([root, tip]);
    (svc as any).partnerCompanyExternService = { cancelByExternalApi: jest.fn(async () => undefined) };
    const seen: Array<Date | null> = [];
    (svc as any).processCancelRefund = jest.fn(async (_o: any, od: any) => {
      seen.push(od.mutationClaimedAt ?? null); // save(merge) 가 보게 될 값
    });

    await svc.cancelOrder(account, 'TR-1', ctx);

    // processCancelRefund 진입 시점의 엔티티가 내 lease 토큰을 들고 있어야 한다(= merge 시 diff 없음 → NULL 미기록)
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Date);
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
