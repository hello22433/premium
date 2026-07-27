// typeorm-transactional 데코레이터를 no-op 으로 mock (실제 DB 트랜잭션 없음)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { DeliveryBatchService } from './delivery.batch.service';

/**
 * 정기 개인정보파기 배치(deliveryDeliveryTargetDestroy) 회귀 테스트.
 *
 * - H-1: order_delivery PII 를 조기파기(executeRequest)와 동일 5종으로 통일 + 환불 진행중 제외.
 * - 리뷰(이기성): order_history 의 PII(수신정보 변경요청/폐기 후 신규 발송 이력의 before/afterChange)도
 *   같이 마스킹해야 함(미파기 시 CS 이력 API 로 평문 수신처 노출). 단 상태 감사 이력은 보존.
 *
 * 생성자 의존성이 많아 Object.create 로 우회 후 필요한 repository 만 mock 주입.
 */
describe('DeliveryBatchService.deliveryDeliveryTargetDestroy', () => {
  // SELECT 용 QueryBuilder mock (where/andWhere 인자 기록)
  const makeSelectQb = (rows: any[]) => {
    const qb: any = { calls: { where: [] as any[], andWhere: [] as any[] } };
    for (const m of ['withDeleted', 'innerJoinAndSelect']) qb[m] = jest.fn(() => qb);
    qb.where = jest.fn((sql: any, params: any) => {
      qb.calls.where.push([sql, params]);
      return qb;
    });
    qb.andWhere = jest.fn((sql: any, params: any) => {
      qb.calls.andWhere.push([sql, params]);
      return qb;
    });
    qb.getMany = jest.fn().mockResolvedValue(rows);
    return qb;
  };

  // order_history UPDATE 용 QueryBuilder mock (set/where/andWhere 인자 기록)
  const makeHistoryQb = () => {
    const qb: any = { calls: { set: [] as any[], where: [] as any[], andWhere: [] as any[] } };
    qb.update = jest.fn(() => qb);
    qb.set = jest.fn((v: any) => {
      qb.calls.set.push(v);
      return qb;
    });
    qb.where = jest.fn((sql: any, p: any) => {
      qb.calls.where.push([sql, p]);
      return qb;
    });
    qb.andWhere = jest.fn((sql: any, p: any) => {
      qb.calls.andWhere.push([sql, p]);
      return qb;
    });
    qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
    return qb;
  };

  const makeSut = (selectQb: any) => {
    const sut: any = Object.create(DeliveryBatchService.prototype);
    const historyQb = makeHistoryQb();
    sut.orderDeliveryRepository = {
      createQueryBuilder: jest.fn(() => selectQb),
      update: jest.fn().mockResolvedValue(undefined),
    };
    sut.orderHistoryRepository = { createQueryBuilder: jest.fn(() => historyQb) };
    sut.__historyQb = historyQb; // 테스트 검사용
    return sut;
  };

  it('order_delivery 마스킹 대상(SET)이 조기파기와 동일 5종이다', async () => {
    const sut = makeSut(makeSelectQb([{ id: 1 }, { id: 2 }]));

    await sut.deliveryDeliveryTargetDestroy();

    expect(sut.orderDeliveryRepository.update).toHaveBeenCalledTimes(1);
    const [, payload] = sut.orderDeliveryRepository.update.mock.calls[0];
    expect(payload).toEqual({
      deliveryTarget: '-',
      originalDeliveryTarget: '-',
      emailReceiverPhone: '-',
      bankAccount: '-',
      bankAccountOwner: '-',
    });
  });

  it('재수집 조건(WHERE)에 5종 미파기 절이 포함된다(backfill)', async () => {
    const selectQb = makeSelectQb([{ id: 1 }]);
    const sut = makeSut(selectQb);

    await sut.deliveryDeliveryTargetDestroy();

    const piiIdempotency = selectQb.calls.andWhere.find(([sql]: [string]) => sql.includes('emailReceiverPhone'));
    expect(piiIdempotency).toBeDefined();
    for (const col of [
      'deliveryTarget',
      'originalDeliveryTarget',
      'emailReceiverPhone',
      'bankAccount',
      'bankAccountOwner',
    ]) {
      expect(piiIdempotency[0]).toContain(col);
    }
  });

  it('soft-delete 된 행도 파기 대상에 포함한다 (폐기후재발행 롤백, 조기파기와 동일 집합)', async () => {
    const selectQb = makeSelectQb([{ id: 1 }]);
    const sut = makeSut(selectQb);

    await sut.deliveryDeliveryTargetDestroy();

    // withDeleted() 없으면 TypeORM 이 deletedAt IS NULL 을 자동 부착해 롤백 soft-delete 행이 영구 미파기.
    expect(selectQb.withDeleted).toHaveBeenCalled();
  });

  it('파기 기준시각 비교는 날짜(DATE) 단위 절삭이다 — 파기예정일 당일 자정 크론에서 파기', async () => {
    const selectQb = makeSelectQb([{ id: 1 }]);
    const sut = makeSut(selectQb);

    await sut.deliveryDeliveryTargetDestroy();

    const [sql] = selectQb.calls.where[0];
    expect(sql).toContain('DATE_ADD(DATE(orderProductMapping.sendRequestAt)');
    expect(sql).toContain('<= DATE(:now)');
  });

  it('환불 진행중(PROGRESS/APPROVE) 제외 조건이 WHERE 에 포함된다 (조기파기 환불 가드 미러링)', async () => {
    const selectQb = makeSelectQb([{ id: 1 }]);
    const sut = makeSut(selectQb);

    await sut.deliveryDeliveryTargetDestroy();

    const refundGuard = selectQb.calls.andWhere.find(([sql]: [string]) => sql.includes('refundStatus'));
    expect(refundGuard).toBeDefined();
    expect(refundGuard[0]).toContain('IS NULL'); // 환불 없는(NULL) 건은 정상 포함
    expect(refundGuard[1].activeRefundStatuses).toEqual(expect.arrayContaining(['PROGRESS', 'APPROVE']));
  });

  it('order_history 는 PII type 만 마스킹하고 상태 감사 이력은 보존한다 (리뷰 반영)', async () => {
    const sut = makeSut(makeSelectQb([{ id: 1 }, { id: 2 }]));

    await sut.deliveryDeliveryTargetDestroy();

    const h = sut.__historyQb;
    // before/afterChange 를 '-' 로
    expect(h.calls.set[0]).toEqual({ beforeChange: '-', afterChange: '-' });
    // 발송건 한정
    expect(h.calls.where[0][0]).toContain('orderDeliveryId');
    // type 필터 = PII type 만 (상태 type 제외)
    const [sql, params] = h.calls.andWhere[0];
    expect(sql).toContain('type');
    expect(params.piiTypes).toEqual(expect.arrayContaining(['수신정보 변경요청', '폐기 후 신규 발송']));
    expect(params.piiTypes).not.toContain('폐기');
    expect(params.piiTypes).not.toContain('환불폐기');
    expect(params.piiTypes).not.toContain('핀상태 변경');
  });

  it('대상이 없으면 update/history 를 호출하지 않는다(멱등)', async () => {
    const sut = makeSut(makeSelectQb([]));

    await sut.deliveryDeliveryTargetDestroy();

    expect(sut.orderDeliveryRepository.update).not.toHaveBeenCalled();
    expect(sut.orderHistoryRepository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
