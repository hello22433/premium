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
