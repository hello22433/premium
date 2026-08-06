import { FindOptionsWhere } from 'typeorm';
import { OrderService } from './order.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { TestOrderDeliveryEntity } from '../../entity/test.order.delivery.entity';

/**
 * 주문 상세의 테스트 발송 이력 노출 기준.
 *
 * 이 기능 이전 구현은 oneSend 호출 '전' 에 status=COMPLETE 로 저장하고 발송이 실패해도 행을 지우지 않았다.
 * 그래서 기존 COMPLETE 행에는 실패 건이 섞여 있고, status 만으로 거르면 과거 실패 발송이 배포 즉시
 * 성공 이력으로 노출된다. 발송 성공 후 각인되는 confirmed_at 이 있는 건만 신뢰해야 한다.
 */
describe('OrderService 테스트 발송 이력 조회 (legacy 오노출 차단)', () => {
  const buildService = (rows: Partial<TestOrderDeliveryEntity>[]) => {
    const service = Object.create(OrderService.prototype) as any;
    const captured: { where?: FindOptionsWhere<TestOrderDeliveryEntity>; order?: unknown }[] = [];

    service.testOrderDeliveryRepository = {
      find: jest.fn((options: any) => {
        captured.push(options);
        // 조회 조건을 실제로 평가한다. 조건이 빠지면 legacy 행이 그대로 흘러나온다.
        const where = options.where ?? {};
        const statusValues: string[] = where.status?._value ?? [];
        const requiresConfirmed = where.confirmedAt !== undefined;
        return Promise.resolve(
          rows.filter(
            (row) =>
              statusValues.includes(row.status as string) && (!requiresConfirmed || (row.confirmedAt ?? null) !== null),
          ),
        );
      }),
    };
    service.cryptoCipher = { safeDecryptDeliveryTarget: (value: string) => value };
    service.captured = captured;
    return service;
  };

  const row = (over: Partial<TestOrderDeliveryEntity>): Partial<TestOrderDeliveryEntity> => ({
    id: 1,
    orderProductMappingId: 5,
    status: IOrderDeliveryStatus.COMPLETE,
    deliveryTarget: '01012345678',
    sendRequestAt: new Date('2026-08-01T10:00:00'),
    confirmedAt: new Date('2026-08-01T10:00:03'),
    ...over,
  });

  it('확정 시각이 없는 legacy COMPLETE 이력은 노출하지 않는다', async () => {
    // legacy 행: 발송 전에 COMPLETE 로 저장돼 성공/실패를 구분할 수 없다.
    const service = buildService([
      row({ id: 1, confirmedAt: null }),
      row({ id: 2, sendRequestAt: new Date('2026-08-02T11:00:00') }),
    ]);

    const result = await service.loadTestDeliveryHistories([5]);

    expect(result.get(5)).toHaveLength(1);
    expect(result.get(5)[0].sendRequestAt).toContain('2026-08-02');
  });

  it('조회 조건에 확정 여부(confirmed_at IS NOT NULL)가 포함된다', async () => {
    const service = buildService([row({})]);

    await service.loadTestDeliveryHistories([5]);

    const where: any = service.captured[0].where;
    expect(where.confirmedAt).toBeDefined();
    expect(where.status._value).toEqual([IOrderDeliveryStatus.COMPLETE, IOrderDeliveryStatus.COMPLETE_SMS]);
  });

  it('발송 중/여부 불명 이력(TEMP/WAIT)은 확정 전이라 노출하지 않는다', async () => {
    const service = buildService([
      row({ id: 1, status: IOrderDeliveryStatus.TEMP, confirmedAt: null }),
      row({ id: 2, status: IOrderDeliveryStatus.WAIT, confirmedAt: null }),
    ]);

    const result = await service.loadTestDeliveryHistories([5]);

    expect(result.size).toBe(0);
  });

  it('상품별로 순번을 1부터 매긴다', async () => {
    const service = buildService([
      row({ id: 1, orderProductMappingId: 5 }),
      row({ id: 2, orderProductMappingId: 5 }),
      row({ id: 3, orderProductMappingId: 9 }),
    ]);

    const result = await service.loadTestDeliveryHistories([5, 9]);

    expect(result.get(5).map((h: any) => h.sequence)).toEqual([1, 2]);
    expect(result.get(9).map((h: any) => h.sequence)).toEqual([1]);
  });

  it('조회 대상 매핑이 없으면 쿼리하지 않는다', async () => {
    const service = buildService([row({})]);

    const result = await service.loadTestDeliveryHistories([]);

    expect(result.size).toBe(0);
    expect(service.testOrderDeliveryRepository.find).not.toHaveBeenCalled();
  });
});
