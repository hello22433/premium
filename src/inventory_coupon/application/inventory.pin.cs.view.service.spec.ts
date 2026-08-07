import { InventoryPinCsViewService } from './inventory.pin.cs.view.service';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';

/**
 * CS 상세의 재고형 계약(rev5 §4.1) 판정 잠금.
 *
 * allowedActions 는 InventoryPinCsService 의 각 액션 가드와 같은 조건이어야 한다.
 * 어긋나면 화면이 할 수 없는 처리를 열거나(호출 시 403/400) 해야 하는 처리를 막는다.
 */
describe('InventoryPinCsViewService.getView', () => {
  const CHAIN_ID = '77';
  const DELIVERY_ID = 1001;

  function build(overrides: {
    delivery?: Partial<OrderDeliveryEntity>;
    chain?: any;
    item?: any;
    activeClaimed?: any;
    latestAttempt?: any;
    refund?: any;
    allocationEnabled?: boolean;
  }) {
    const chain =
      overrides.chain === undefined
        ? { id: CHAIN_ID, state: 'DEBITED', currentOrderDeliveryId: DELIVERY_ID }
        : overrides.chain;

    const attemptRepo = {
      findOne: jest.fn(async (opts: any) =>
        opts.where.status === 'CLAIMED' ? (overrides.activeClaimed ?? null) : (overrides.latestAttempt ?? null),
      ),
    };

    const sut = new InventoryPinCsViewService(
      { findOne: jest.fn(async () => overrides.item ?? null) } as any,
      { findOne: jest.fn(async () => chain) } as any,
      attemptRepo as any,
      { findOne: jest.fn(async () => overrides.refund ?? null) } as any,
      {
        readPolicy: jest.fn(async () => ({
          applicationsOpen: true,
          allocationEnabled: overrides.allocationEnabled ?? true,
          version: 1,
        })),
      } as any,
    );

    const delivery = {
      id: DELIVERY_ID,
      inventoryPinBillingChainId: CHAIN_ID,
      directPinFulfillmentStatus: 'SENT',
      directPinLatestAttemptId: null,
      ...overrides.delivery,
    } as OrderDeliveryEntity;

    return { sut, delivery };
  }

  const assignedItem = {
    id: '5',
    primaryCodeMasked: 'ABCD-****',
    secondaryCodeMasked: null,
    status: 'ASSIGNED',
  };

  it('재고형이 아니면 null — 일반 쿠폰 응답은 그대로 둔다', async () => {
    const { sut, delivery } = build({
      delivery: { inventoryPinBillingChainId: null, directPinFulfillmentStatus: null },
    });
    await expect(sut.getView(delivery)).resolves.toBeNull();
  });

  it('DEBITED + 소유자 + ASSIGNED → reveal 허용, 실행 가능한 액션 전부 노출', async () => {
    const { sut, delivery } = build({
      item: assignedItem,
      delivery: { directPinFulfillmentStatus: 'PENDING_SEND' },
    });

    const view = await sut.getView(delivery);

    expect(view).toMatchObject({
      deliveryContentMode: 'DIRECT_PIN',
      primaryPinMasked: 'ABCD-****',
      pinInventoryStatus: 'ASSIGNED',
      fulfillmentStatus: 'PENDING_SEND',
      latestAttemptStatus: 'NONE',
      paymentState: 'DEBITED',
      isCurrentPaymentOwner: true,
      canRevealPin: true,
      canRevealHistoricalPin: false,
    });
    expect(view!.allowedActions.sort()).toEqual(
      ['RESEND_SAME_PIN', 'TERMINAL_CANCEL_REFUND', 'VOID_AND_REISSUE'].sort(),
    );
  });

  // 실행할 엔드포인트가 없는 액션은 절대 내려주지 않는다 — 프론트가 못 누르는 버튼을 연다.
  it('CHANGE_TARGET_BEFORE_SEND 는 PENDING_SEND 여도 미노출 (수신정보 변경 API 부재)', async () => {
    const { sut, delivery } = build({
      item: assignedItem,
      delivery: { directPinFulfillmentStatus: 'PENDING_SEND' },
    });
    const view = await sut.getView(delivery);
    expect(view!.allowedActions).not.toContain('CHANGE_TARGET_BEFORE_SEND');
  });

  it('CLAIMED attempt 진행 중이면 액션 전부 차단 (SEND_IN_PROGRESS 가드와 동일)', async () => {
    const { sut, delivery } = build({ item: assignedItem, activeClaimed: { id: '9' } });
    const view = await sut.getView(delivery);
    expect(view!.latestAttemptStatus).toBe('CLAIMED');
    expect(view!.allowedActions).toEqual([]);
  });

  it('소유권이 넘어간 옛 발송건은 reveal·액션 모두 차단 (SUPERSEDED_DELIVERY)', async () => {
    const { sut, delivery } = build({
      item: assignedItem,
      chain: { id: CHAIN_ID, state: 'DEBITED', currentOrderDeliveryId: 2002 },
    });
    const view = await sut.getView(delivery);
    expect(view!.isCurrentPaymentOwner).toBe(false);
    expect(view!.canRevealPin).toBe(false);
    expect(view!.allowedActions).toEqual([]);
  });

  it('REFUNDED 체인은 reveal·액션 모두 차단 (ALREADY_REFUNDED)', async () => {
    const { sut, delivery } = build({
      item: assignedItem,
      chain: { id: CHAIN_ID, state: 'REFUNDED', currentOrderDeliveryId: DELIVERY_ID },
    });
    const view = await sut.getView(delivery);
    expect(view!.paymentState).toBe('REFUNDED');
    expect(view!.canRevealPin).toBe(false);
    expect(view!.allowedActions).toEqual([]);
  });

  it('VOID 건은 reveal 차단, 환불만 남는다', async () => {
    const { sut, delivery } = build({
      item: { ...assignedItem, status: 'VOID' },
      delivery: { directPinFulfillmentStatus: 'VOID' },
    });
    const view = await sut.getView(delivery);
    expect(view!.pinInventoryStatus).toBe('VOID');
    expect(view!.canRevealPin).toBe(false);
    expect(view!.allowedActions).toEqual(['TERMINAL_CANCEL_REFUND']);
  });

  it('환불 row 가 이미 있으면 동일 PIN 재발송 불가', async () => {
    const { sut, delivery } = build({ item: assignedItem, refund: { id: 3 } });
    const view = await sut.getView(delivery);
    expect(view!.allowedActions).not.toContain('RESEND_SAME_PIN');
  });

  it('allocationEnabled=false 면 폐기 후 재발급 미노출 (fail-closed)', async () => {
    const { sut, delivery } = build({ item: assignedItem, allocationEnabled: false });
    const view = await sut.getView(delivery);
    expect(view!.allowedActions).not.toContain('VOID_AND_REISSUE');
  });

  it('최신 attempt 가 FAILED 면 그대로 내려준다', async () => {
    const { sut, delivery } = build({
      item: assignedItem,
      delivery: { directPinLatestAttemptId: '42', directPinFulfillmentStatus: 'FAILED' },
      latestAttempt: { id: '42', status: 'FAILED' },
    });
    const view = await sut.getView(delivery);
    expect(view!.latestAttemptStatus).toBe('FAILED');
  });
});
