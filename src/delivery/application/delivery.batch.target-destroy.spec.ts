// typeorm-transactional 데코레이터를 no-op 으로 mock (실제 DB 트랜잭션 없음)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { DeliveryBatchService } from './delivery.batch.service';

/**
 * H-1 회귀 테스트 — 정기 개인정보파기 배치(deliveryDeliveryTargetDestroy).
 *
 * 결함: 배치가 deliveryTarget/originalDeliveryTarget 2종만 마스킹하고 나머지 수신/계좌 PII(emailReceiverPhone,
 *      bankAccount, bankAccountOwner)는 미파기 → 조기파기(executeRequest, 5종)와 비대칭.
 * 수정: 운영 정책 확인 후 조기파기와 동일 5종으로 통일 — ① SET 5종 ② 재수집 WHERE 에 5종 미파기 조건
 *      (과거 일부만 파기된 행 backfill).
 *
 * 생성자 의존성이 많아 Object.create 로 우회 후 orderDeliveryRepository 만 mock 주입.
 */
describe('DeliveryBatchService.deliveryDeliveryTargetDestroy — H-1 PII 5종 파기', () => {
  const makeQb = (rows: any[]) => {
    const qb: any = { calls: { andWhere: [] as any[] } };
    for (const m of ['innerJoinAndSelect', 'where']) qb[m] = jest.fn(() => qb);
    qb.andWhere = jest.fn((sql: any, params: any) => {
      qb.calls.andWhere.push([sql, params]);
      return qb;
    });
    qb.getMany = jest.fn().mockResolvedValue(rows);
    return qb;
  };

  const makeSut = (qb: any) => {
    const sut: any = Object.create(DeliveryBatchService.prototype);
    sut.orderDeliveryRepository = {
      createQueryBuilder: jest.fn(() => qb),
      update: jest.fn().mockResolvedValue(undefined),
    };
    return sut;
  };

  it('마스킹 대상(SET)이 조기파기와 동일 5종이다', async () => {
    const qb = makeQb([{ id: 1 }, { id: 2 }]);
    const sut = makeSut(qb);

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
    const qb = makeQb([{ id: 1 }]);
    const sut = makeSut(qb);

    await sut.deliveryDeliveryTargetDestroy();

    const piiIdempotency = qb.calls.andWhere.find(([sql]: [string]) => sql.includes('emailReceiverPhone'));
    expect(piiIdempotency).toBeDefined();
    for (const col of ['deliveryTarget', 'originalDeliveryTarget', 'emailReceiverPhone', 'bankAccount', 'bankAccountOwner']) {
      expect(piiIdempotency[0]).toContain(col);
    }
  });

  it('환불 진행중(PROGRESS/APPROVE) 제외 조건이 WHERE 에 포함된다 (조기파기 환불 가드 미러링)', async () => {
    const qb = makeQb([{ id: 1 }]);
    const sut = makeSut(qb);

    await sut.deliveryDeliveryTargetDestroy();

    const refundGuard = qb.calls.andWhere.find(([sql]: [string]) => sql.includes('refundStatus'));
    expect(refundGuard).toBeDefined();
    expect(refundGuard[0]).toContain('IS NULL'); // 환불 없는(NULL) 건은 정상 포함
    expect(refundGuard[1].activeRefundStatuses).toEqual(expect.arrayContaining(['PROGRESS', 'APPROVE']));
  });

  it('대상이 없으면 update 를 호출하지 않는다(멱등)', async () => {
    const qb = makeQb([]);
    const sut = makeSut(qb);

    await sut.deliveryDeliveryTargetDestroy();

    expect(sut.orderDeliveryRepository.update).not.toHaveBeenCalled();
  });
});
