// typeorm-transactional 데코레이터를 no-op 으로 mock (실제 DB 트랜잭션 없음)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { EarlyDestroyService } from './early.destroy.service';
import { EarlyDestroyRequestStatus } from '../../entity/early.destroy.request.entity';
import { IOrderStatus } from '../interface/order.status';

/**
 * createRequestForDeliveries 검증 분기 + L-1(중복 PENDING 가드) 회귀 테스트.
 *
 * - L-2: 조기파기 등록 경로 테스트 공백 보강.
 * - L-1: 동일 발송건에 대기 중인 요청이 있으면 새 등록을 거부한다.
 *
 * 생성자 의존성이 많아 Object.create 로 우회 후 협력자만 mock 주입.
 */
describe('EarlyDestroyService.createRequestForDeliveries — 검증/L-1', () => {
  const user = { id: 9, email: 'op@enmad.com' } as any;

  const buildDelivery = (id: number, orderId = 77, over: any = {}) => ({
    id,
    deliveryTarget: `enc-${id}`,
    originalDeliveryTarget: `enc-orig-${id}`,
    orderProductMappingId: 55,
    orderProductMapping: { orderId },
    ...over,
  });

  const makeSut = (cfg: { deliveries?: any[]; order?: any; pending?: any[] } = {}) => {
    const sut: any = Object.create(EarlyDestroyService.prototype);
    sut.orderDeliveryRepository = { find: jest.fn().mockResolvedValue(cfg.deliveries ?? []) };
    sut.orderRepository = {
      findOne: jest.fn().mockResolvedValue(cfg.order ?? { id: 77, status: IOrderStatus.DELIVERY_COMPLETE }),
    };
    sut.earlyDestroyRequestRepository = {
      find: jest.fn().mockResolvedValue(cfg.pending ?? []),
      create: jest.fn((x: any) => x),
      save: jest.fn().mockResolvedValue({ id: 500 }),
    };
    sut.earlyDestroyRequestItemRepository = {
      create: jest.fn((x: any) => x),
      save: jest.fn().mockResolvedValue(undefined),
    };
    return sut;
  };

  it('빈 배열은 거부한다', async () => {
    const sut = makeSut();
    await expect(sut.createRequestForDeliveries({ orderDeliveryIds: [] }, user)).rejects.toThrow('비어 있습니다');
  });

  it('존재하지 않는 발송건 ID가 섞이면 거부한다', async () => {
    const sut = makeSut({ deliveries: [buildDelivery(101)] }); // 요청은 2개인데 1개만 조회됨
    await expect(
      sut.createRequestForDeliveries({ orderDeliveryIds: [101, 999] }, user),
    ).rejects.toThrow('유효하지 않은 발송건');
  });

  it('서로 다른 주문의 발송건이 섞이면 거부한다', async () => {
    const sut = makeSut({ deliveries: [buildDelivery(101, 77), buildDelivery(102, 88)] });
    await expect(
      sut.createRequestForDeliveries({ orderDeliveryIds: [101, 102] }, user),
    ).rejects.toThrow('서로 다른 주문');
  });

  it('이미 파기된 발송건이 포함되면 거부한다', async () => {
    const destroyed = buildDelivery(101, 77, { deliveryTarget: '-', originalDeliveryTarget: '-' });
    const sut = makeSut({ deliveries: [destroyed] });
    await expect(sut.createRequestForDeliveries({ orderDeliveryIds: [101] }, user)).rejects.toThrow('이미 파기된');
  });

  it('동일 발송건에 대기 중(PENDING) 요청이 있으면 거부한다 (L-1)', async () => {
    const sut = makeSut({
      deliveries: [buildDelivery(101)],
      pending: [{ items: [{ orderProductMappingId: 55, orderDeliveryId: 101 }] }],
    });
    await expect(sut.createRequestForDeliveries({ orderDeliveryIds: [101] }, user)).rejects.toThrow(
      '이미 대기 중인',
    );
  });

  it('매핑 전체 PENDING 이 있으면 그 매핑의 발송건 신규 등록을 거부한다 (L-1 교차 겹침)', async () => {
    const sut = makeSut({
      deliveries: [buildDelivery(101)], // mappingId 55
      pending: [{ items: [{ orderProductMappingId: 55, orderDeliveryId: null }] }], // 매핑 55 전체 대기
    });
    await expect(sut.createRequestForDeliveries({ orderDeliveryIds: [101] }, user)).rejects.toThrow(
      '이미 대기 중인',
    );
  });

  it('같은 매핑이라도 서로 다른 발송건 PENDING 은 신규 발송건을 막지 않는다 (과차단 방지)', async () => {
    const sut = makeSut({
      deliveries: [buildDelivery(102)], // mappingId 55, 신규는 102
      pending: [{ items: [{ orderProductMappingId: 55, orderDeliveryId: 101 }] }], // 다른 발송건 101 대기
    });
    const result = await sut.createRequestForDeliveries({ orderDeliveryIds: [102] }, user);
    expect(result).toEqual({ id: 500 }); // 겹치지 않으므로 정상 등록
  });

  it('정상 등록 시 요청 + 항목이 저장된다', async () => {
    const sut = makeSut({ deliveries: [buildDelivery(101), buildDelivery(102)] });

    const result = await sut.createRequestForDeliveries({ orderDeliveryIds: [101, 102] }, user);

    expect(result).toEqual({ id: 500 });
    // 요청 헤더는 PENDING 으로 저장
    expect(sut.earlyDestroyRequestRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 77, status: EarlyDestroyRequestStatus.PENDING, requestedBy: 9 }),
    );
    // 발송건 2건이 항목으로 저장
    expect(sut.earlyDestroyRequestItemRepository.save).toHaveBeenCalledTimes(1);
    const savedItems = sut.earlyDestroyRequestItemRepository.save.mock.calls[0][0];
    expect(savedItems).toHaveLength(2);
    expect(savedItems[0]).toEqual(
      expect.objectContaining({ earlyDestroyRequestId: 500, orderDeliveryId: 101 }),
    );
  });
});

describe('EarlyDestroyService.createRequest(매핑 단위) — L-1 교차 겹침', () => {
  const user = { id: 9, email: 'op@enmad.com' } as any;

  // createRequest 경로 전용 SUT (orderProductMapping 조회 + nonDestroyed QueryBuilder 포함)
  const makeMappingSut = (cfg: { mappingIds?: number[]; pending?: any[] } = {}) => {
    const mappingIds = cfg.mappingIds ?? [55];
    const sut: any = Object.create(EarlyDestroyService.prototype);
    sut.orderRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 77, status: IOrderStatus.DELIVERY_COMPLETE }),
    };
    sut.orderProductMappingRepository = {
      find: jest.fn().mockResolvedValue(mappingIds.map((id) => ({ id }))),
    };
    // nonDestroyed 집계: 모든 매핑이 미파기 발송건 보유로 통과
    const qb: any = {};
    for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) qb[m] = jest.fn(() => qb);
    qb.getRawMany = jest.fn().mockResolvedValue(mappingIds.map((id) => ({ mappingId: id, cnt: '1' })));
    sut.orderDeliveryRepository = { createQueryBuilder: jest.fn(() => qb) };
    sut.earlyDestroyRequestRepository = {
      find: jest.fn().mockResolvedValue(cfg.pending ?? []),
      create: jest.fn((x: any) => x),
      save: jest.fn().mockResolvedValue({ id: 600 }),
    };
    sut.earlyDestroyRequestItemRepository = {
      create: jest.fn((x: any) => x),
      save: jest.fn().mockResolvedValue(undefined),
    };
    return sut;
  };

  it('경우 A — 매핑 전체 PENDING 이 있으면 같은 매핑 전체 신규를 거부한다', async () => {
    const sut = makeMappingSut({ pending: [{ items: [{ orderProductMappingId: 55, orderDeliveryId: null }] }] });
    await expect(sut.createRequest(77, { orderProductMappingIds: [55] }, user)).rejects.toThrow('상품매핑');
  });

  it('경우 D — 발송건 일부만 PENDING 이면 매핑 전체 신규는 허용한다 (나머지 발송건 파기, 모순 방지)', async () => {
    const sut = makeMappingSut({ pending: [{ items: [{ orderProductMappingId: 55, orderDeliveryId: 101 }] }] });
    const result = await sut.createRequest(77, { orderProductMappingIds: [55] }, user);
    expect(result).toEqual({ id: 600 }); // 상위집합이므로 허용
  });

  it('다른 매핑의 PENDING 은 영향 없이 통과한다 (과차단 방지)', async () => {
    const sut = makeMappingSut({ pending: [{ items: [{ orderProductMappingId: 66, orderDeliveryId: null }] }] });
    const result = await sut.createRequest(77, { orderProductMappingIds: [55] }, user);
    expect(result).toEqual({ id: 600 });
  });
});
