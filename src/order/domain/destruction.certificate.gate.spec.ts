import { resolveDestructionCertificateGate } from './destruction.certificate.gate';
import { DestructionCertificateBlockReason } from '../interface/destruction.certificate.block.reason';
import { IOrderStatus } from '../interface/order.status';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';

/**
 * 파기확인서 발행 게이트 판정 회귀 테스트 (0710/backend-response 문서의 판정식).
 *
 * 판정은 deliveryTarget 단일 컬럼 — 날짜(sendRequestAt + 파기일수)는 판정에 쓰이지 않는다.
 * 조기파기 직후(파기예정일 전)에도 발행 가능해야 한다는 것이 핵심 요구.
 */
describe('resolveDestructionCertificateGate', () => {
  const makeOrder = (status: IOrderStatus, deliveriesPerMapping: any[][]): any => ({
    status,
    orderProductMappings: deliveriesPerMapping.map((orderDeliveries) => ({ orderDeliveries })),
  });

  const destroyed = (over: any = {}) => ({ deliveryTarget: '-', refundStatus: null, ...over });
  const alive = (over: any = {}) => ({ deliveryTarget: 'enc-01012341234', refundStatus: null, ...over });

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
});
