// 실제 DB 연결 없는 단위 테스트이므로 typeorm-transactional 데코레이터를 no-op으로 mock한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliverySsgInsertStateEntity } from '../../entity/order.delivery.ssg.insert.state.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { MarkAttemptedResult, SsgInsertState } from '../interface/ssg.insert.state';
import { SsgAttemptPayload, SsgConfirmInfo, SsgInsertStateService } from './ssg-insert-state.service';

/**
 * SsgInsertStateService 단위 테스트 (별 테이블 기반)
 *
 * 검증 범위:
 *  1) state machine (Lazy)
 *     (row 없음 = NONE) → ATTEMPTED (markAttempted INSERT)
 *     FAILED → ATTEMPTED (markAttempted 재시도, 재발송 새 PIN 발급)
 *     ATTEMPTED → CONFIRMED (markConfirmed)
 *     ATTEMPTED → FAILED (markFailed)
 *     CONFIRMED 는 terminal. ATTEMPTED 중복 호출은 idempotent skip.
 *  2) markAttempted: INSERT IGNORE 후 affected=0 이면 FAILED→ATTEMPTED UPDATE 시도, 전이 성공 시에만 log INSERT
 *  3) markConfirmed: state UPDATE + order_delivery PIN 컬럼 best-effort 저장
 *  4) markFailed: state 만 UPDATE
 *  5) getState: row 없으면 NONE 반환
 */
describe('SsgInsertStateService', () => {
  let sut: SsgInsertStateService;
  let stateRepository: jest.Mocked<Repository<OrderDeliverySsgInsertStateEntity>>;
  let deliveryRepository: jest.Mocked<Repository<OrderDeliveryEntity>>;
  let issueLogRepository: jest.Mocked<Repository<SsgIssueLogEntity>>;

  const makeInsertChain = (executeImpl: () => Promise<{ raw: { affectedRows: number } }>) => {
    const chain: any = {
      insert: jest.fn(() => chain),
      into: jest.fn(() => chain),
      values: jest.fn(() => chain),
      orIgnore: jest.fn(() => chain),
      execute: jest.fn(executeImpl),
    };
    return chain;
  };

  const makeUpdateChain = (executeImpl: () => Promise<{ affected: number }>) => {
    const chain: any = {
      update: jest.fn(() => chain),
      set: jest.fn(() => chain),
      where: jest.fn(() => chain),
      andWhere: jest.fn(() => chain),
      execute: jest.fn(executeImpl),
    };
    return chain;
  };

  const samplePayload: SsgAttemptPayload = {
    barCode: '80000001',
    personalCode: '01312345678',
    ssgTransactionId: 'tr-1',
    eventNo: 'EV1',
    eventSeq: 1,
    ssgEventId: 42,
    expireAt: new Date('2026-07-18T00:00:00Z'),
    encourageAt: new Date('2026-06-01T00:00:00Z'),
    couponNum: 'CN-1',
  };

  const sampleConfirm: SsgConfirmInfo = {
    barCode: '80000001',
    personalCode: '01312345678',
    ssgTransactionId: 'tr-1',
    couponNum: 'CN-1',
    expireAt: new Date('2026-07-18T00:00:00Z'),
    encourageAt: new Date('2026-06-01T00:00:00Z'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    stateRepository = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<OrderDeliverySsgInsertStateEntity>>;

    deliveryRepository = {
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<OrderDeliveryEntity>>;

    issueLogRepository = {
      insert: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<Repository<SsgIssueLogEntity>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SsgInsertStateService,
        { provide: getRepositoryToken(OrderDeliverySsgInsertStateEntity), useValue: stateRepository },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: deliveryRepository },
        { provide: getRepositoryToken(SsgIssueLogEntity), useValue: issueLogRepository },
      ],
    }).compile();

    sut = module.get(SsgInsertStateService);
  });

  describe('markAttempted (row 없음 또는 FAILED → ATTEMPTED)', () => {
    it('row 없음 → INSERT IGNORE affected=1 → log INSERT → TRANSITIONED 반환', async () => {
      const chain = makeInsertChain(async () => ({ raw: { affectedRows: 1 } }));
      (stateRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      const result = await sut.markAttempted(123, samplePayload);

      expect(result).toBe(MarkAttemptedResult.TRANSITIONED);
      expect(chain.values).toHaveBeenCalledWith({
        orderDeliveryId: 123,
        state: SsgInsertState.ATTEMPTED,
      });
      expect(chain.orIgnore).toHaveBeenCalled();
      expect(issueLogRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          orderDeliveryId: 123,
          barCode: samplePayload.barCode,
          personalCode: samplePayload.personalCode,
          ssgTransactionId: samplePayload.ssgTransactionId,
          eventNo: samplePayload.eventNo,
          eventSeq: samplePayload.eventSeq,
          ssgEventId: samplePayload.ssgEventId,
          expireAt: samplePayload.expireAt,
          encourageAt: samplePayload.encourageAt,
          couponNum: samplePayload.couponNum,
        }),
      );
    });

    it('FAILED row 존재 → INSERT 0 affected → UPDATE FAILED→ATTEMPTED 성공 → 새 log INSERT + TRANSITIONED 반환', async () => {
      const insertChain = makeInsertChain(async () => ({ raw: { affectedRows: 0 } }));
      const updateChain = makeUpdateChain(async () => ({ affected: 1 }));
      (stateRepository.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(insertChain)
        .mockReturnValueOnce(updateChain);

      const result = await sut.markAttempted(123, samplePayload);

      expect(result).toBe(MarkAttemptedResult.TRANSITIONED);
      expect(updateChain.set).toHaveBeenCalledWith({ state: SsgInsertState.ATTEMPTED });
      expect(updateChain.andWhere).toHaveBeenCalledWith('state = :prev', { prev: SsgInsertState.FAILED });
      expect(issueLogRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ orderDeliveryId: 123, barCode: samplePayload.barCode }),
      );
    });

    it('ATTEMPTED row 존재 (중복 호출) → SKIPPED_ACTIVE 반환, log INSERT 건너뜀', async () => {
      const insertChain = makeInsertChain(async () => ({ raw: { affectedRows: 0 } }));
      const updateChain = makeUpdateChain(async () => ({ affected: 0 }));
      (stateRepository.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(insertChain)
        .mockReturnValueOnce(updateChain);
      stateRepository.findOne = jest.fn().mockResolvedValue({
        orderDeliveryId: 123,
        state: SsgInsertState.ATTEMPTED,
      });

      const result = await sut.markAttempted(123, samplePayload);

      expect(result).toBe(MarkAttemptedResult.SKIPPED_ACTIVE);
      expect(issueLogRepository.insert).not.toHaveBeenCalled();
    });

    it('CONFIRMED row 존재 (terminal) → SKIPPED_TERMINAL 반환, log INSERT 건너뜀', async () => {
      const insertChain = makeInsertChain(async () => ({ raw: { affectedRows: 0 } }));
      const updateChain = makeUpdateChain(async () => ({ affected: 0 }));
      (stateRepository.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(insertChain)
        .mockReturnValueOnce(updateChain);
      stateRepository.findOne = jest.fn().mockResolvedValue({
        orderDeliveryId: 123,
        state: SsgInsertState.CONFIRMED,
      });

      const result = await sut.markAttempted(123, samplePayload);

      expect(result).toBe(MarkAttemptedResult.SKIPPED_TERMINAL);
      expect(issueLogRepository.insert).not.toHaveBeenCalled();
    });
  });

  describe('markConfirmed (ATTEMPTED → CONFIRMED)', () => {
    it('state UPDATE WHERE state=ATTEMPTED 가드 + delivery PIN 컬럼 저장 + true 반환', async () => {
      const stateChain = makeUpdateChain(async () => ({ affected: 1 }));
      const deliveryChain = makeUpdateChain(async () => ({ affected: 1 }));
      (stateRepository.createQueryBuilder as jest.Mock).mockReturnValue(stateChain);
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(deliveryChain);

      const result = await sut.markConfirmed(123, sampleConfirm);

      expect(result).toBe(true);
      expect(stateChain.set).toHaveBeenCalledWith({ state: SsgInsertState.CONFIRMED });
      expect(stateChain.andWhere).toHaveBeenCalledWith('state = :prev', { prev: SsgInsertState.ATTEMPTED });
      expect(deliveryChain.set).toHaveBeenCalledWith({
        barCode: sampleConfirm.barCode,
        personalCode: sampleConfirm.personalCode,
        ssgTransactionId: sampleConfirm.ssgTransactionId,
        couponNum: sampleConfirm.couponNum,
        expireAt: sampleConfirm.expireAt,
        encourageAt: sampleConfirm.encourageAt,
      });
    });

    it('row 없음/CONFIRMED/FAILED 에서 호출 시 state affected=0 → delivery UPDATE 건너뜀 + false 반환', async () => {
      const stateChain = makeUpdateChain(async () => ({ affected: 0 }));
      (stateRepository.createQueryBuilder as jest.Mock).mockReturnValue(stateChain);

      const result = await sut.markConfirmed(123, sampleConfirm);

      expect(result).toBe(false);
      // deliveryRepository.createQueryBuilder 는 호출되지 않아야 한다
      expect(deliveryRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('markFailed (ATTEMPTED → FAILED)', () => {
    it('state 만 UPDATE (실패에는 PIN 보존 데이터 없음) + true 반환', async () => {
      const chain = makeUpdateChain(async () => ({ affected: 1 }));
      (stateRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      const result = await sut.markFailed(123);

      expect(result).toBe(true);
      expect(chain.set).toHaveBeenCalledWith({ state: SsgInsertState.FAILED });
      expect(chain.andWhere).toHaveBeenCalledWith('state = :prev', { prev: SsgInsertState.ATTEMPTED });
    });

    it('row 없음/CONFIRMED 역행 시도 → affected=0 → silently skip + false 반환', async () => {
      const chain = makeUpdateChain(async () => ({ affected: 0 }));
      (stateRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      await expect(sut.markFailed(123)).resolves.toBe(false);
    });
  });

  describe('getState (Lazy)', () => {
    it('row 있으면 row.state 반환', async () => {
      stateRepository.findOne = jest.fn().mockResolvedValue({
        orderDeliveryId: 123,
        state: SsgInsertState.ATTEMPTED,
      });

      const state = await sut.getState(123);
      expect(state).toBe(SsgInsertState.ATTEMPTED);
    });

    it('row 없으면 NONE 반환', async () => {
      stateRepository.findOne = jest.fn().mockResolvedValue(null);

      const state = await sut.getState(123);
      expect(state).toBe(SsgInsertState.NONE);
    });
  });
});
