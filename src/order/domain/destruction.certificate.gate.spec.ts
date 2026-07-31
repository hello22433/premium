import { resolveDestructionCertificateGate } from './destruction.certificate.gate';
import { DestructionCertificateBlockReason } from '../interface/destruction.certificate.block.reason';
import { IOrderStatus } from '../interface/order.status';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';

/**
 * 파기확인서 발행 게이트 판정 회귀 테스트 (0710/backend-response 문서의 판정식).
 *
 * 판정 술어는 여전히 deliveryTarget 단일 컬럼이고, **파기예정일은 판정에 쓰이지 않는다** —
 * 조기파기 직후(파기예정일 전)에도 발행 가능해야 한다는 것이 원래 요구다.
 *
 * 여기에 파기일 축 교차 검증이 하나 얹혔다(리뷰 3차 H-1): 전량 파기로 보이더라도
 *  · 파기 시각을 특정할 수 없으면 → DESTROY_TIME_UNKNOWN
 *  · 2축 술어로는 아직 안 지워진 행이 섞여 있으면(수신처 부활 등) → NOT_DESTROYED
 * 날짜가 확인서에 실리므로, 날짜를 답할 수 없으면 발행도 못 한다.
 * ⚠️ 백필 역산(ACTUAL_ESTIMATED)은 막지 않는다 — 막으면 레거시 주문 전체가 발행 불가가 된다.
 */
describe('resolveDestructionCertificateGate', () => {
  const makeOrder = (status: IOrderStatus, deliveriesPerMapping: any[][]): any => ({
    status,
    orderProductMappings: deliveriesPerMapping.map((orderDeliveries) => ({
      orderDeliveries,
      sendRequestAt: new Date('2026-01-01T14:00:00'),
      requestToDestroyPersonalInfoDay: 180,
    })),
  });

  /**
   * 파기 완료 발송건. 파기 시각 각인까지 있는 정상 상태를 기본값으로 둔다 —
   * 각인이 빠지면 이제 게이트가 막으므로, 각인 없는 픽스처를 기본으로 두면 전 케이스가
   * DESTROY_TIME_UNKNOWN 으로 쏠려 원래 검증 의도가 사라진다.
   */
  const destroyed = (over: any = {}) => ({
    deliveryTarget: '-',
    emailReceiverPhone: '-',
    refundStatus: null,
    expireAt: null,
    deletedAt: null,
    destroyedAt: new Date('2026-02-01T09:30:00'),
    destroyedAtSource: 'BATCH',
    ...over,
  });
  const alive = (over: any = {}) => ({
    deliveryTarget: 'enc-01012341234',
    emailReceiverPhone: null,
    refundStatus: null,
    expireAt: null,
    deletedAt: null,
    destroyedAt: null,
    destroyedAtSource: null,
    ...over,
  });

  it('발송 완료가 아니면 DELIVERY_NOT_COMPLETE', () => {
    const order = makeOrder(IOrderStatus.DELIVERY_REQUEST, [[destroyed()]]);
    expect(resolveDestructionCertificateGate(order)).toEqual({
      canIssue: false,
      reason: DestructionCertificateBlockReason.DELIVERY_NOT_COMPLETE,
    });
  });

  it('모든 발송건이 파기(deliveryTarget = "-")면 발행 가능 — 날짜와 무관(조기파기 직후 포함)', () => {
    const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [[destroyed(), destroyed()]]);
    expect(resolveDestructionCertificateGate(order)).toEqual({ canIssue: true, reason: null });
  });

  it('전량 파기 완료면 환불 진행중 건이 있어도 발행 가능 (파기 후 신규 환불이 발행을 막지 않음)', () => {
    const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [
      [destroyed({ refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS }), destroyed()],
    ]);
    expect(resolveDestructionCertificateGate(order)).toEqual({ canIssue: true, reason: null });
  });

  it('미파기 건이 있고 그중 환불 PROGRESS 가 있으면 REFUND_IN_PROGRESS', () => {
    const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [
      [destroyed(), alive({ refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS })],
    ]);
    expect(resolveDestructionCertificateGate(order)).toEqual({
      canIssue: false,
      reason: DestructionCertificateBlockReason.REFUND_IN_PROGRESS,
    });
  });

  it('미파기 건이 있고 그중 환불 APPROVE 가 있으면 REFUND_IN_PROGRESS', () => {
    const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [
      [alive({ refundStatus: OrderDeliveryRefundStatusEnum.APPROVE })],
    ]);
    expect(resolveDestructionCertificateGate(order)).toEqual({
      canIssue: false,
      reason: DestructionCertificateBlockReason.REFUND_IN_PROGRESS,
    });
  });

  it('환불 COMPLETE 는 진행중이 아니다 — 미파기면 NOT_DESTROYED', () => {
    const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [
      [alive({ refundStatus: OrderDeliveryRefundStatusEnum.COMPLETE })],
    ]);
    expect(resolveDestructionCertificateGate(order)).toEqual({
      canIssue: false,
      reason: DestructionCertificateBlockReason.NOT_DESTROYED,
    });
  });

  it('미파기 건이 있고 환불이 없으면 NOT_DESTROYED (파기예정일 전 / 배치 미실행)', () => {
    const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [[destroyed(), alive()]]);
    expect(resolveDestructionCertificateGate(order)).toEqual({
      canIssue: false,
      reason: DestructionCertificateBlockReason.NOT_DESTROYED,
    });
  });

  it('다중 매핑: 한 매핑만 파기 완료면 NOT_DESTROYED (첫 매핑 편향 방지 — 전 발송건 전수 판정)', () => {
    const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [[destroyed()], [alive()]]);
    expect(resolveDestructionCertificateGate(order)).toEqual({
      canIssue: false,
      reason: DestructionCertificateBlockReason.NOT_DESTROYED,
    });
  });

  it('발송건이 없으면 NOT_DESTROYED (증명할 파기 대상이 없음)', () => {
    const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [[]]);
    expect(resolveDestructionCertificateGate(order)).toEqual({
      canIssue: false,
      reason: DestructionCertificateBlockReason.NOT_DESTROYED,
    });
  });

  it('orderProductMappings 미로드(undefined)여도 throw 하지 않고 NOT_DESTROYED', () => {
    const order = { status: IOrderStatus.DELIVERY_COMPLETE } as any;
    expect(resolveDestructionCertificateGate(order)).toEqual({
      canIssue: false,
      reason: DestructionCertificateBlockReason.NOT_DESTROYED,
    });
  });

  describe('파기일 축 교차 검증 (리뷰 3차 H-1)', () => {
    it('★ 파기됐는데 시각 기록이 없으면 DESTROY_TIME_UNKNOWN — 날짜 칸을 채울 수 없다', () => {
      const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [
        [destroyed(), destroyed({ destroyedAt: null, destroyedAtSource: null })],
      ]);
      expect(resolveDestructionCertificateGate(order)).toEqual({
        canIssue: false,
        reason: DestructionCertificateBlockReason.DESTROY_TIME_UNKNOWN,
      });
    });

    it('★ 수신처가 되살아난 행이 섞이면 NOT_DESTROYED — 게이트만 보면 통과하던 조합', () => {
      // delivery_target='-' 인데 email_receiver_phone 은 살아있다.
      // 1축 게이트는 "전량 파기"로 읽지만 실제로는 PII 가 남아 있다.
      const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [
        [destroyed(), destroyed({ emailReceiverPhone: 'enc-01099998888' })],
      ]);
      expect(resolveDestructionCertificateGate(order)).toEqual({
        canIssue: false,
        reason: DestructionCertificateBlockReason.NOT_DESTROYED,
      });
    });

    it('★ 레거시 부분마스킹 행(유효기간 잔존)도 같은 이유로 막힌다 — 미래 날짜 인쇄 차단', () => {
      const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [
        [
          destroyed({
            emailReceiverPhone: 'enc-01099998888',
            expireAt: new Date('2031-01-01T00:00:00'),
            destroyedAt: new Date('2026-06-30T00:00:00'),
            destroyedAtSource: 'BACKFILL_ESTIMATE',
          }),
        ],
      ]);
      expect(resolveDestructionCertificateGate(order)).toEqual({
        canIssue: false,
        reason: DestructionCertificateBlockReason.NOT_DESTROYED,
      });
    });

    it('★ 백필 역산(ACTUAL_ESTIMATED)은 발행 가능하다 — 막으면 레거시 전체가 발행 불가', () => {
      // 파기 사실은 확정이고 날짜만 추정이다. 정확도는 effectiveDestroyAtKind 로 전달한다.
      const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [
        [destroyed({ destroyedAtSource: 'BACKFILL_ESTIMATE' }), destroyed({ destroyedAtSource: 'BACKFILL_EARLY' })],
      ]);
      expect(resolveDestructionCertificateGate(order)).toEqual({ canIssue: true, reason: null });
    });

    it('★ 전량 마스킹 + 수신처 생존 + 환불 진행중이면 REFUND_IN_PROGRESS 가 아니라 NOT_DESTROYED', () => {
      // 사유 우선순위가 바뀐 유일한 조합이다(리뷰 4차 LOW). 종전에는 every('-') 에서 곧바로
      // canIssue: true 였고, 환불 분기에는 애초에 도달하지 않았다.
      // 살아있는 PII 가 있다는 사실이 환불 진행 여부보다 앞선 차단 사유다.
      const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [
        [
          destroyed(),
          destroyed({
            emailReceiverPhone: 'enc-01099998888',
            refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS,
          }),
        ],
      ]);
      expect(resolveDestructionCertificateGate(order)).toEqual({
        canIssue: false,
        reason: DestructionCertificateBlockReason.NOT_DESTROYED,
      });
    });

    it('출처가 비어 있어도(시각은 있음) 발행은 가능하다 — 막는 기준은 날짜 유무다', () => {
      const order = makeOrder(IOrderStatus.DELIVERY_COMPLETE, [[destroyed({ destroyedAtSource: null })]]);
      expect(resolveDestructionCertificateGate(order)).toEqual({ canIssue: true, reason: null });
    });
  });
});
