import { DeliveryBatchService } from './delivery.batch.service';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { IOrderStatus } from '../../order/interface/order.status';

/**
 * 주문 완료 판정에서 CANCEL 을 터미널로 보는 계약.
 *
 * 배경: 부분취소한 주문은 CANCEL 과 COMPLETE 가 섞인다. CANCEL 이 비터미널이면
 * 잔여분을 전부 발송해도 "전건 터미널" 이 되지 않아 DELIVERY_COMPLETE 로 전이되지 않고,
 * 자동 선정산에서도 빠진다 — 영구 미완료·미정산.
 *
 * 반대로 전체취소 주문이 이 때문에 완료로 전이되면 안 된다. 그건 터미널 목록이 아니라
 * transitionOrderToComplete 의 CAS 조건(order.status = DELIVERY_CONFIRMED)이 막는다.
 */
describe('DeliveryBatchService — 주문 완료 판정에서 CANCEL 을 터미널로 본다', () => {
  const setup = (nonTerminalCount: number) => {
    const captured: { conditions: string[]; params: Record<string, unknown> } = { conditions: [], params: {} };

    const orderDeliveryRepository: any = {
      createQueryBuilder: () => {
        const b: any = {
          innerJoin: () => b,
          where: (c: string, p?: Record<string, unknown>) => {
            captured.conditions.push(c);
            Object.assign(captured.params, p ?? {});
            return b;
          },
          andWhere: (c: string, p?: Record<string, unknown>) => {
            captured.conditions.push(c);
            Object.assign(captured.params, p ?? {});
            return b;
          },
          getCount: async () => nonTerminalCount,
        };
        return b;
      },
    };

    const updateResult = { affected: 1 };
    const orderRepository: any = {
      createQueryBuilder: () => {
        const b: any = {
          update: () => b,
          set: () => b,
          where: (c: string, p?: Record<string, unknown>) => {
            captured.conditions.push(c);
            Object.assign(captured.params, p ?? {});
            return b;
          },
          andWhere: (c: string, p?: Record<string, unknown>) => {
            captured.conditions.push(c);
            Object.assign(captured.params, p ?? {});
            return b;
          },
          execute: async () => updateResult,
        };
        return b;
      },
    };

    const sut: any = Object.create(DeliveryBatchService.prototype);
    sut.orderDeliveryRepository = orderDeliveryRepository;
    sut.orderRepository = orderRepository;
    return { sut, captured };
  };

  it('터미널 목록에 CANCEL 이 포함된다', async () => {
    const { sut, captured } = setup(0);

    await sut.isOrderAllDeliveriesTerminal(1001);

    expect(captured.params.terminal).toContain(IOrderDeliveryStatus.CANCEL);
  });

  it('기존 터미널 상태 4종도 그대로 유지된다', async () => {
    const { sut, captured } = setup(0);

    await sut.isOrderAllDeliveriesTerminal(1001);

    expect(captured.params.terminal).toEqual(
      expect.arrayContaining([
        IOrderDeliveryStatus.COMPLETE,
        IOrderDeliveryStatus.COMPLETE_SMS,
        IOrderDeliveryStatus.FAIL,
        IOrderDeliveryStatus.FAIL_SMS,
      ]),
    );
  });

  // WAIT/TEMP 는 여전히 비터미널이어야 한다 — 아직 나갈 게 남은 주문을 완료로 올리면 안 된다.
  it('WAIT / TEMP 는 터미널이 아니다', async () => {
    const { sut, captured } = setup(0);

    await sut.isOrderAllDeliveriesTerminal(1001);

    expect(captured.params.terminal).not.toContain(IOrderDeliveryStatus.WAIT);
    expect(captured.params.terminal).not.toContain(IOrderDeliveryStatus.TEMP);
  });

  it('비터미널이 0건이면 전건 터미널로 본다', async () => {
    const { sut } = setup(0);

    await expect(sut.isOrderAllDeliveriesTerminal(1001)).resolves.toBe(true);
  });

  it('비터미널이 남아 있으면 전건 터미널이 아니다', async () => {
    const { sut } = setup(2);

    await expect(sut.isOrderAllDeliveriesTerminal(1001)).resolves.toBe(false);
  });

  // ★ 전체취소 주문이 완료로 전이되지 않는 근거. 터미널 목록이 아니라 이 CAS 조건이 막는다.
  it('완료 전이는 DELIVERY_CONFIRMED 인 주문만 대상으로 한다 (전체취소 주문 자연 제외)', async () => {
    const { sut, captured } = setup(0);

    await sut.transitionOrderToComplete(1001);

    expect(captured.conditions).toContain('status = :confirmed');
    expect(captured.params.confirmed).toBe(IOrderStatus.DELIVERY_CONFIRMED);
  });
});
