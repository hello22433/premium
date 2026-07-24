jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_t: unknown, _k: unknown, d: PropertyDescriptor) => d,
}));
import { SsgEventService } from './ssg.event.service';

/**
 * SSG 행사잔액 차감/복구의 **변경 전 기준선**(197-16 SSG 부분취소 준비).
 *
 * 지금 동작을 못 박아, 뒤이어 발송건별 기록(order_delivery_id)으로 바꿀 때 "최종 잔액은 그대로,
 * 행만 세분" 이 지켜지는지 판정할 기준으로 쓴다. 이 스펙이 깨지면 동작이 바뀐 것이다.
 *
 *  - deductEventBalanceMultiple: 발송건이 여럿이어도 **행사별 1행으로 합산**(order_delivery_id 없음)
 *  - restoreEventBalance(orderId): 주문의 이력 행을 **전량** 복구
 */
describe('SsgEventService deduct/restore — 변경 전 기준선 (baseline)', () => {
  const makeSut = (events: Record<number, { id: number; eventBalance: number }>) => {
    const created: any[] = [];
    const ssgEventRepository = {
      createQueryBuilder: jest.fn(() => {
        let capturedId = 0;
        const b: any = {
          setLock: () => b,
          where: (_cond: string, params: { id: number }) => {
            capturedId = params.id;
            return b;
          },
          getOne: async () => events[capturedId] ?? null,
        };
        return b;
      }),
      save: jest.fn(async () => undefined),
    };
    const amountHistoryRepository = {
      create: jest.fn((v: any) => {
        created.push(v);
        return v;
      }),
      save: jest.fn(async () => undefined),
      find: jest.fn(async () => [] as any[]),
    };
    const service: any = new SsgEventService(
      ssgEventRepository as any,
      amountHistoryRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, created, events, amountHistoryRepository };
  };

  it('[현행] deduct: 발송건 2건을 행사별 1행으로 합산 (order_delivery_id 없음)', async () => {
    const { service, created, events } = makeSut({ 10: { id: 10, eventBalance: 100000 } });

    await service.deductEventBalanceMultiple(
      [
        { deliveryId: 1, eventId: 10, price: 5000 },
        { deliveryId: 2, eventId: 10, price: 5000 },
      ],
      700,
      true,
    );

    expect(created).toHaveLength(1); // 합산 1행
    expect(created[0]).toMatchObject({ ssgEventId: 10, amount: -10000, orderId: 700, isTemporary: true });
    // 발송건 귀속을 남기지 않는다 — 이 때문에 SSG 는 발송건별 부분복구를 못 하고 부분취소가 400 이다.
    // (귀속 컬럼 order_delivery_id 는 SSG 부분취소 후속 티켓에서 엔티티·마이그레이션과 함께 들어간다.)
    expect(created[0].orderDeliveryId).toBeUndefined();
    expect(events[10].eventBalance).toBe(90000); // 100000 - 10000
  });

  it('[현행] deduct: 서로 다른 행사는 행사별로 각각 1행', async () => {
    const { service, created, events } = makeSut({
      10: { id: 10, eventBalance: 100000 },
      11: { id: 11, eventBalance: 100000 },
    });

    await service.deductEventBalanceMultiple(
      [
        { deliveryId: 1, eventId: 10, price: 5000 },
        { deliveryId: 2, eventId: 11, price: 7000 },
      ],
      700,
      true,
    );

    expect(created).toHaveLength(2);
    expect(events[10].eventBalance).toBe(95000);
    expect(events[11].eventBalance).toBe(93000);
  });

  it('[현행] restore(orderId): 주문의 이력을 전량 복구 (범위 지정 없음)', async () => {
    const { service, created, events, amountHistoryRepository } = makeSut({ 10: { id: 10, eventBalance: 90000 } });
    amountHistoryRepository.find = jest.fn(async () => [{ ssgEventId: 10, amount: -10000 }]);

    await service.restoreEventBalance(700);

    expect(created).toHaveLength(1); // 복구 1행
    expect(created[0]).toMatchObject({ ssgEventId: 10, amount: 10000, orderId: 700, isTemporary: false });
    expect(events[10].eventBalance).toBe(100000); // 90000 + 10000
  });
});
