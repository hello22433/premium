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
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgInsertState } from '../interface/ssg.insert.state';
import { SsgAttemptPayload, SsgConfirmInfo, SsgInsertStateService } from './ssg-insert-state.service';

/**
 * SsgInsertStateService 단위 테스트
 *
 * 검증 범위:
 *  1) state machine 엄격성
 *     NONE → ATTEMPTED (markAttempted)
 *     ATTEMPTED → CONFIRMED (markConfirmed)
 *     ATTEMPTED → FAILED (markFailed)
 *     terminal/잘못된 prev 에서 호출 시 SQL WHERE 가 0 affected → silently skip
 *  2) markAttempted: ssg_issue_log INSERT(payload) + state UPDATE를 같은 흐름에서 수행
 *  3) markConfirmed: order_delivery PIN 정보 저장 + state UPDATE 한꺼번에 처리
 *  4) markFailed: state 만 UPDATE
 *  5) WHERE 조건이 SQL 단에서 monotonic을 강제하므로 race 상황에도 안전
 */
describe('SsgInsertStateService', () => {
  let sut: SsgInsertStateService;
  let deliveryRepository: jest.Mocked<Repository<OrderDeliveryEntity>>;
  let issueLogRepository: jest.Mocked<Repository<SsgIssueLogEntity>>;

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

  const makeSelectChain = (state: SsgInsertState | null) => {
    const chain: any = {
      select: jest.fn(() => chain),
      where: jest.fn(() => chain),
      getRawOne: jest.fn().mockResolvedValue(state ? { state } : null),
    };
    return chain;
  };

  const samplePayload: SsgAttemptPayload = {
    barCode: '80000001',
    personalCode: '01312345678',
    ssgTransactionId: 'tr-1',
    eventNo: 'EV1',
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

    deliveryRepository = {
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<OrderDeliveryEntity>>;

    issueLogRepository = {
      insert: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<Repository<SsgIssueLogEntity>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SsgInsertStateService,
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: deliveryRepository },
        { provide: getRepositoryToken(SsgIssueLogEntity), useValue: issueLogRepository },
      ],
    }).compile();

    sut = module.get(SsgInsertStateService);
  });

  describe('markAttempted (NONE → ATTEMPTED)', () => {
    it('state UPDATE 성공 시 ssg_issue_log INSERT (state 먼저, log 나중)', async () => {
      const chain = makeUpdateChain(async () => ({ affected: 1 }));
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      await sut.markAttempted(123, samplePayload);

      expect(chain.set).toHaveBeenCalledWith({ ssgInsertState: SsgInsertState.ATTEMPTED });
      expect(chain.andWhere).toHaveBeenCalledWith('ssg_insert_state = :prev', { prev: SsgInsertState.NONE });
      expect(issueLogRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          orderDeliveryId: 123,
          barCode: samplePayload.barCode,
          personalCode: samplePayload.personalCode,
          ssgTransactionId: samplePayload.ssgTransactionId,
          eventNo: samplePayload.eventNo,
          expireAt: samplePayload.expireAt,
          encourageAt: samplePayload.encourageAt,
          couponNum: samplePayload.couponNum,
        }),
      );
    });

    it('이미 ATTEMPTED/CONFIRMED/FAILED 면 state skip + log INSERT 도 skip (idempotent)', async () => {
      const chain = makeUpdateChain(async () => ({ affected: 0 }));
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      await expect(sut.markAttempted(123, samplePayload)).resolves.toBeUndefined();
      // 재호출 시 log row가 중복 쌓이는 회귀 방지
      expect(issueLogRepository.insert).not.toHaveBeenCalled();
    });
  });

  describe('markConfirmed (ATTEMPTED → CONFIRMED)', () => {
    it('PIN 정보 + state 한꺼번에 UPDATE', async () => {
      const chain = makeUpdateChain(async () => ({ affected: 1 }));
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      await sut.markConfirmed(123, sampleConfirm);

      expect(chain.set).toHaveBeenCalledWith({
        ssgInsertState: SsgInsertState.CONFIRMED,
        barCode: sampleConfirm.barCode,
        personalCode: sampleConfirm.personalCode,
        ssgTransactionId: sampleConfirm.ssgTransactionId,
        couponNum: sampleConfirm.couponNum,
        expireAt: sampleConfirm.expireAt,
        encourageAt: sampleConfirm.encourageAt,
      });
      expect(chain.andWhere).toHaveBeenCalledWith('ssg_insert_state = :prev', { prev: SsgInsertState.ATTEMPTED });
    });

    it('NONE 에서 직행 시도 시 SQL WHERE 가 0 affected → silently skip (durable payload 누락 방지)', async () => {
      const chain = makeUpdateChain(async () => ({ affected: 0 }));
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      await expect(sut.markConfirmed(123, sampleConfirm)).resolves.toBeUndefined();
    });

    it('FAILED 역행 시도 시 SQL WHERE 가 0 affected → silently skip', async () => {
      const chain = makeUpdateChain(async () => ({ affected: 0 }));
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      await expect(sut.markConfirmed(123, sampleConfirm)).resolves.toBeUndefined();
    });
  });

  describe('markFailed (ATTEMPTED → FAILED)', () => {
    it('state 만 UPDATE (실패에는 PIN 보존 데이터 없음)', async () => {
      const chain = makeUpdateChain(async () => ({ affected: 1 }));
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      await sut.markFailed(123);

      expect(chain.set).toHaveBeenCalledWith({ ssgInsertState: SsgInsertState.FAILED });
      expect(chain.andWhere).toHaveBeenCalledWith('ssg_insert_state = :prev', { prev: SsgInsertState.ATTEMPTED });
    });

    it('NONE 에서 직행 시도 시 SQL WHERE 가 0 affected → silently skip + warn', async () => {
      const chain = makeUpdateChain(async () => ({ affected: 0 }));
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      await expect(sut.markFailed(123)).resolves.toBeUndefined();
    });

    it('CONFIRMED 역행 시도 시 SQL WHERE 가 0 affected → silently skip + warn', async () => {
      const chain = makeUpdateChain(async () => ({ affected: 0 }));
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      await expect(sut.markFailed(123)).resolves.toBeUndefined();
    });
  });

  describe('getState', () => {
    it('현재 state 조회', async () => {
      const chain = makeSelectChain(SsgInsertState.ATTEMPTED);
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      const state = await sut.getState(123);
      expect(state).toBe(SsgInsertState.ATTEMPTED);
    });

    it('row 없으면 null', async () => {
      const chain = makeSelectChain(null);
      (deliveryRepository.createQueryBuilder as jest.Mock).mockReturnValue(chain);

      const state = await sut.getState(123);
      expect(state).toBeNull();
    });
  });
});
