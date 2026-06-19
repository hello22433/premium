// typeorm-transactional 데코레이터를 no-op 으로 mock (실제 DB 트랜잭션 없음)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { EarlyDestroyService, PII_BEARING_HISTORY_TYPES } from './early.destroy.service';
import { EarlyDestroyRequestStatus } from '../../entity/early.destroy.request.entity';
import { IOrderStatus } from '../interface/order.status';

/**
 * 조기파기 실행(executeRequest) C-1 회귀 테스트.
 *
 * C-1: order_history.beforeChange/afterChange 마스킹이 type 구분 없이 해당 발송건의 전 이력 행을
 *      '-' 로 덮어, 폐기/환불폐기/핀상태 변경의 couponStatus 전이 감사기록(NOT_USED→CANCEL 등)을
 *      파괴하던 결함. (order_history.before/after 는 type 별 다형 컬럼 — 상태값 vs 평문 PII)
 * 수정: order_history UPDATE 에 type IN (수신정보 변경요청, 폐기 후 신규 발송) 필터를 추가해
 *      PII 보유 이력만 마스킹하고 상태 감사기록은 보존한다.
 *
 * 생성자 의존성이 많아 Object.create 로 우회 후 협력자만 mock 주입. (discard-concurrency.spec 관례)
 */
describe('EarlyDestroyService.executeRequest — C-1 order_history type 필터', () => {
  const user = { id: 9, email: 'op@enmad.com' } as any;

  // 호출 인자를 기록하는 fluent QueryBuilder mock
  const makeQb = () => {
    const qb: any = { calls: { where: [] as any[], andWhere: [] as any[], set: [] as any[] } };
    qb.update = jest.fn(() => qb);
    qb.set = jest.fn((v: any) => {
      qb.calls.set.push(v);
      return qb;
    });
    qb.where = jest.fn((sql: any, params: any) => {
      qb.calls.where.push([sql, params]);
      return qb;
    });
    qb.andWhere = jest.fn((sql: any, params: any) => {
      qb.calls.andWhere.push([sql, params]);
      return qb;
    });
    qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
    return qb;
  };

  const makeSut = (historyQb: any, deliveryQb: any) => {
    const sut: any = Object.create(EarlyDestroyService.prototype);
    sut.earlyDestroyRequestRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 1,
        orderId: 77,
        status: EarlyDestroyRequestStatus.PENDING,
        items: [{ orderProductMappingId: 55, orderDeliveryId: 101 }], // 발송건 단위 항목
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    // M-2: 실행 시점 주문상태 재검증용
    sut.orderRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 77, status: IOrderStatus.DELIVERY_COMPLETE }),
    };
    sut.orderDeliveryRepository = {
      find: jest.fn().mockResolvedValue([]), // 매핑 확장 경로(이 케이스선 미사용)
      count: jest.fn().mockResolvedValue(0), // 환불 진행중 없음
      createQueryBuilder: jest.fn(() => deliveryQb),
    };
    sut.orderHistoryRepository = {
      createQueryBuilder: jest.fn(() => historyQb),
    };
    sut.logger = { log: jest.fn() };
    return sut;
  };

  it('order_history 마스킹은 PII 보유 type(수신정보 변경요청/폐기 후 신규 발송)으로만 한정된다', async () => {
    const historyQb = makeQb();
    const deliveryQb = makeQb();
    const sut = makeSut(historyQb, deliveryQb);

    await sut.executeRequest(1, user);

    // history UPDATE 에 발송건 조건 + type 필터(andWhere)가 모두 적용됐는지
    expect(historyQb.where).toHaveBeenCalled();
    expect(historyQb.calls.where[0][0]).toContain('orderDeliveryId');

    expect(historyQb.andWhere).toHaveBeenCalled();
    const [sql, params] = historyQb.calls.andWhere[0];
    expect(sql).toContain('type');
    expect(params.piiTypes).toEqual(expect.arrayContaining(['수신정보 변경요청', '폐기 후 신규 발송']));

    // 상태 감사 type 은 마스킹 대상에 포함되지 않아야 함 (C-1 핵심)
    expect(params.piiTypes).not.toContain('폐기');
    expect(params.piiTypes).not.toContain('환불폐기');
    expect(params.piiTypes).not.toContain('핀상태 변경');
  });

  it('PII_BEARING_HISTORY_TYPES 는 상태 감사 type 을 포함하지 않는다', () => {
    expect([...PII_BEARING_HISTORY_TYPES]).toEqual(['수신정보 변경요청', '폐기 후 신규 발송']);
    for (const statusType of ['폐기', '환불폐기', '핀상태 변경', '재전송']) {
      expect(PII_BEARING_HISTORY_TYPES).not.toContain(statusType);
    }
  });

  it('order_delivery PII 5종 마스킹 + 요청 COMPLETED 전이는 그대로 유지(회귀 방지)', async () => {
    const historyQb = makeQb();
    const deliveryQb = makeQb();
    const sut = makeSut(historyQb, deliveryQb);

    await sut.executeRequest(1, user);

    expect(deliveryQb.calls.set[0]).toEqual({
      deliveryTarget: '-',
      originalDeliveryTarget: '-',
      emailReceiverPhone: '-',
      bankAccount: '-',
      bankAccountOwner: '-',
    });
    expect(sut.earlyDestroyRequestRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: EarlyDestroyRequestStatus.COMPLETED,
        executedBy: 9,
      }),
    );
  });

  it('실행 시점 주문이 DELIVERY_COMPLETE 가 아니면 거부한다 (M-2 하드닝)', async () => {
    const historyQb = makeQb();
    const deliveryQb = makeQb();
    const sut = makeSut(historyQb, deliveryQb);
    // 등록~실행 사이 주문이 발송취소된 상황
    sut.orderRepository.findOne.mockResolvedValue({ id: 77, status: IOrderStatus.DELIVERY_CANCEL });

    await expect(sut.executeRequest(1, user)).rejects.toThrow('발송 완료된 주문만');

    // 마스킹/상태전이가 전혀 일어나지 않아야 함
    expect(deliveryQb.execute).not.toHaveBeenCalled();
    expect(historyQb.execute).not.toHaveBeenCalled();
    expect(sut.earlyDestroyRequestRepository.update).not.toHaveBeenCalled();
  });
});

describe('EarlyDestroyService.executeRequest — 환불 가드 + 요청 검증 (D3-41)', () => {
  const user = { id: 9, email: 'op@enmad.com' } as any;

  const makeQb = () => {
    const qb: any = {};
    qb.update = jest.fn(() => qb);
    qb.set = jest.fn(() => qb);
    qb.where = jest.fn(() => qb);
    qb.andWhere = jest.fn(() => qb);
    qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
    return qb;
  };

  const DEFAULT_REQUEST = {
    id: 1,
    orderId: 77,
    status: EarlyDestroyRequestStatus.PENDING,
    items: [{ orderProductMappingId: 55, orderDeliveryId: 101 }],
  };

  const makeSut = (cfg: {
    request?: any;
    order?: any;
    refundInProgressCount?: number;
    mappingDeliveries?: any[];
  } = {}) => {
    const sut: any = Object.create(EarlyDestroyService.prototype);
    sut.earlyDestroyRequestRepository = {
      findOne: jest.fn().mockResolvedValue('request' in cfg ? cfg.request : DEFAULT_REQUEST),
      update: jest.fn().mockResolvedValue(undefined),
    };
    sut.orderRepository = {
      findOne: jest.fn().mockResolvedValue(cfg.order ?? { id: 77, status: IOrderStatus.DELIVERY_COMPLETE }),
    };
    sut.orderDeliveryRepository = {
      find: jest.fn().mockResolvedValue(cfg.mappingDeliveries ?? []),
      count: jest.fn().mockResolvedValue(cfg.refundInProgressCount ?? 0),
      createQueryBuilder: jest.fn(() => makeQb()),
    };
    sut.orderHistoryRepository = { createQueryBuilder: jest.fn(() => makeQb()) };
    sut.logger = { log: jest.fn() };
    return sut;
  };

  it('요청이 없으면 거부한다', async () => {
    const sut = makeSut({ request: null });
    await expect(sut.executeRequest(1, user)).rejects.toThrow('조기파기 요청이 존재하지 않습니다');
  });

  it('PENDING 상태가 아니면 거부한다', async () => {
    const sut = makeSut({
      request: { ...DEFAULT_REQUEST, status: EarlyDestroyRequestStatus.COMPLETED },
    });
    await expect(sut.executeRequest(1, user)).rejects.toThrow('대기 중인 요청만');
  });

  it('환불 진행중(PROGRESS/APPROVE)인 발송건이 있으면 파기를 거부한다', async () => {
    const sut = makeSut({ refundInProgressCount: 1 });
    await expect(sut.executeRequest(1, user)).rejects.toThrow('환불 진행 중인 건');
    // 환불 가드 이후 PII 파기·상태전이가 실행되지 않아야 한다
    expect(sut.orderDeliveryRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(sut.orderHistoryRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(sut.earlyDestroyRequestRepository.update).not.toHaveBeenCalled();
  });

  it('매핑 단위 항목은 발송건으로 확장된 뒤 환불 가드가 적용된다', async () => {
    const sut = makeSut({
      request: {
        ...DEFAULT_REQUEST,
        items: [{ orderProductMappingId: 55, orderDeliveryId: null }], // 매핑 단위
      },
      mappingDeliveries: [{ id: 201 }, { id: 202 }], // 확장 결과
      refundInProgressCount: 1,
    });
    await expect(sut.executeRequest(1, user)).rejects.toThrow('환불 진행 중인 건');
    // 매핑→발송건 확장을 위한 find 가 호출됐는지 확인
    expect(sut.orderDeliveryRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orderProductMappingId: expect.anything() }) }),
    );
    // 확장된 발송건 [201, 202] 을 대상으로 count 가 호출됐는지 확인
    expect(sut.orderDeliveryRepository.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: expect.anything() }) }),
    );
  });
});
