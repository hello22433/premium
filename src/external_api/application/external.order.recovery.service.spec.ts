// typeorm-transactional 데코레이터를 no-op 으로 mock (실제 DB 트랜잭션 없음)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_t: unknown, _k: unknown, d: PropertyDescriptor) => d,
}));

import { ExternalOrderRecoveryService } from './external.order.recovery.service';
import { IOrderType } from '../../order/interface/order.type';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

/**
 * 검증:
 *  - 후보 조회 필터(EXTERNAL/SSG + DELIVERY_REQUEST + WAIT + barCode + grace cutoff)
 *  - 완료 전이 CAS(delivery WAIT→COMPLETE, order DELIVERY_REQUEST→DELIVERY_COMPLETE)
 *  - order CAS affected 로 recovered/skipped 집계, 건별 예외 격리
 *  - grace env override
 *  - 후보 0건 → update 미실행
 */
describe('ExternalOrderRecoveryService', () => {
  const OLD_ENV = process.env.EXTERNAL_ORDER_RECOVERY_GRACE_MS;

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.EXTERNAL_ORDER_RECOVERY_GRACE_MS;
    else process.env.EXTERNAL_ORDER_RECOVERY_GRACE_MS = OLD_ENV;
    jest.clearAllMocks();
  });

  const makeChainBuilder = (terminal: { getRawMany?: jest.Mock; execute?: jest.Mock }) => {
    const b: any = {};
    for (const m of [
      'innerJoin',
      'select',
      'addSelect',
      'where',
      'andWhere',
      'groupBy',
      'addGroupBy',
      'limit',
      'update',
      'set',
    ]) {
      b[m] = jest.fn(() => b);
    }
    b.getRawMany = terminal.getRawMany ?? jest.fn().mockResolvedValue([]);
    b.execute = terminal.execute ?? jest.fn().mockResolvedValue({ affected: 1 });
    return b;
  };

  const makeSut = (opts: { candidates: any[]; deliveryAffected?: number; orderAffectedQueue?: number[] }) => {
    const selectBuilder = makeChainBuilder({
      getRawMany: jest.fn().mockResolvedValue(opts.candidates),
    });
    const deliveryUpdateExec = jest.fn().mockResolvedValue({ affected: opts.deliveryAffected ?? 1 });
    const deliveryUpdateBuilder = makeChainBuilder({ execute: deliveryUpdateExec });

    // orderDeliveryRepository.createQueryBuilder: 첫 호출(select) = 후보조회, 이후(update) = delivery CAS
    const odCreateQb = jest
      .fn()
      .mockImplementationOnce(() => selectBuilder)
      .mockImplementation(() => deliveryUpdateBuilder);

    const orderQueue = [...(opts.orderAffectedQueue ?? [1])];
    const orderUpdateExec = jest.fn().mockImplementation(async () => ({
      affected: orderQueue.length ? orderQueue.shift() : 1,
    }));
    const orderUpdateBuilder = makeChainBuilder({ execute: orderUpdateExec });
    const orderCreateQb = jest.fn().mockImplementation(() => orderUpdateBuilder);

    const orderDeliveryRepository = { createQueryBuilder: odCreateQb } as any;
    const orderRepository = { createQueryBuilder: orderCreateQb } as any;

    const sut = new ExternalOrderRecoveryService(orderRepository, orderDeliveryRepository);

    return {
      sut,
      selectBuilder,
      deliveryUpdateBuilder,
      deliveryUpdateExec,
      orderUpdateBuilder,
      orderUpdateExec,
    };
  };

  it('후보 조회 필터: EXTERNAL/SSG + DELIVERY_REQUEST + WAIT + barCode + grace cutoff 적용', async () => {
    const { sut, selectBuilder } = makeSut({ candidates: [] });

    await sut.recoverStuckOrders();

    expect(selectBuilder.where).toHaveBeenCalledWith('o.type IN (:...types)', {
      types: [IOrderType.EXTERNAL, IOrderType.SSG],
    });
    expect(selectBuilder.andWhere).toHaveBeenCalledWith('o.status = :req', {
      req: IOrderStatus.DELIVERY_REQUEST,
    });
    expect(selectBuilder.andWhere).toHaveBeenCalledWith('od.status = :wait', {
      wait: IOrderDeliveryStatus.WAIT,
    });
    expect(selectBuilder.andWhere).toHaveBeenCalledWith('od.barCode IS NOT NULL');
    // grace cutoff: registerAt < cutoff
    const cutoffCall = selectBuilder.andWhere.mock.calls.find((c: any[]) => c[0] === 'o.registerAt < :cutoff');
    expect(cutoffCall).toBeDefined();
    expect(cutoffCall[1].cutoff).toBeInstanceOf(Date);
  });

  it('후보 0건 → delivery/order update 미실행, 통계 0', async () => {
    const { sut, deliveryUpdateExec, orderUpdateExec } = makeSut({ candidates: [] });

    const stats = await sut.recoverStuckOrders();

    expect(deliveryUpdateExec).not.toHaveBeenCalled();
    expect(orderUpdateExec).not.toHaveBeenCalled();
    expect(stats).toEqual({ candidates: 0, recovered: 0, skipped: 0 });
  });

  it('완료 전이: delivery WAIT→COMPLETE, order DELIVERY_REQUEST→DELIVERY_COMPLETE (CAS)', async () => {
    const { sut, deliveryUpdateBuilder, orderUpdateBuilder } = makeSut({
      candidates: [{ orderId: 1579, deliveryId: 42, sentAt: '2026-07-07T06:10:04.000Z' }],
    });

    const stats = await sut.recoverStuckOrders();

    // delivery: status=COMPLETE + actualSendAt, WHERE status=WAIT
    expect(deliveryUpdateBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: IOrderDeliveryStatus.COMPLETE }),
    );
    expect(deliveryUpdateBuilder.set.mock.calls[0][0].actualSendAt).toBeInstanceOf(Date);
    expect(deliveryUpdateBuilder.andWhere).toHaveBeenCalledWith('status = :wait', {
      wait: IOrderDeliveryStatus.WAIT,
    });
    // order: status=DELIVERY_COMPLETE, WHERE id + status=DELIVERY_REQUEST
    expect(orderUpdateBuilder.set).toHaveBeenCalledWith({ status: IOrderStatus.DELIVERY_COMPLETE });
    expect(orderUpdateBuilder.where).toHaveBeenCalledWith('id = :id', { id: 1579 });
    expect(orderUpdateBuilder.andWhere).toHaveBeenCalledWith('status = :req', {
      req: IOrderStatus.DELIVERY_REQUEST,
    });
    expect(stats).toEqual({ candidates: 1, recovered: 1, skipped: 1 - 1 });
  });

  it('order CAS affected=0(이미 전이됨/경합) → skipped 로 집계', async () => {
    const { sut } = makeSut({
      candidates: [
        { orderId: 1, deliveryId: 11, sentAt: null },
        { orderId: 2, deliveryId: 12, sentAt: null },
      ],
      orderAffectedQueue: [1, 0],
    });

    const stats = await sut.recoverStuckOrders();

    expect(stats).toEqual({ candidates: 2, recovered: 1, skipped: 1 });
  });

  it('sentAt=null 이면 actualSendAt 을 현재시각으로 백필', async () => {
    const { sut, deliveryUpdateBuilder } = makeSut({
      candidates: [{ orderId: 3, deliveryId: 13, sentAt: null }],
    });

    await sut.recoverStuckOrders();

    expect(deliveryUpdateBuilder.set.mock.calls[0][0].actualSendAt).toBeInstanceOf(Date);
  });

  it('grace env override 반영(cutoff = now - graceMs)', async () => {
    process.env.EXTERNAL_ORDER_RECOVERY_GRACE_MS = '600000'; // 10분
    const { sut, selectBuilder } = makeSut({ candidates: [] });

    const before = Date.now();
    await sut.recoverStuckOrders();
    const after = Date.now();

    const cutoffCall = selectBuilder.andWhere.mock.calls.find((c: any[]) => c[0] === 'o.registerAt < :cutoff');
    const cutoff: Date = cutoffCall[1].cutoff;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 600000 - 50);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 600000 + 50);
  });
});
