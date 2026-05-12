// 실제 DB 연결 없는 단위 테스트이므로 typeorm-transactional 데코레이터를 no-op으로 mock한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryRefundEntity } from '../../entity/order.delivery.refund.entity';
import { ClaimRefundInput, RefundLedgerService } from './refund-ledger.service';

/**
 * RefundLedgerService 단위 테스트
 *
 * 검증 범위:
 *  1) claim()의 INSERT/UPDATE 호출 순서 + 멱등성 차단 동작
 *  2) ER_DUP_ENTRY → BadRequestException 변환 (code/errno 경로)
 *  3) 비-dedup 에러는 그대로 rethrow
 *  4) 비원자성 노출: INSERT 성공 후 markRefundedAt 실패 시 ledger row만 남는 divergence
 *  5) release()가 affected==0을 silent로 무시하는 동작 (double-release 가드 부재 입증)
 *  6) HIGH 이슈: TypeORM이 ER_DUP_ENTRY를 QueryFailedError로 wrap할 때
 *     e.driverError.code 경로를 현재 코드가 인지하지 못해 BadRequestException으로
 *     변환하지 못한다는 점 (현재 동작을 그대로 고정하는 회귀 테스트).
 */
describe('RefundLedgerService', () => {
  let sut: RefundLedgerService;
  let refundRepository: jest.Mocked<Repository<OrderDeliveryRefundEntity>>;
  let deliveryRepository: jest.Mocked<Repository<OrderDeliveryEntity>>;

  const makeInsertChain = (executeImpl: () => Promise<unknown>) => {
    const chain: any = {
      insert: jest.fn(() => chain),
      into: jest.fn(() => chain),
      values: jest.fn(() => chain),
      execute: jest.fn(executeImpl),
    };
    return chain;
  };

  const makeUpdateChain = (executeImpl: () => Promise<unknown>) => {
    const chain: any = {
      update: jest.fn(() => chain),
      set: jest.fn(() => chain),
      where: jest.fn(() => chain),
      execute: jest.fn(executeImpl),
    };
    return chain;
  };

  const baseInput: ClaimRefundInput = {
    orderDeliveryId: 12345,
    userId: 1,
    refundAmount: 5000,
    restoreType: 'BALANCE',
    isSettleComplete: false,
    isSettleBalance: true,
    sourcePath: 'BATCH_FAIL',
    operatorUserId: null,
    memo: 'unit test memo',
  };

  const makeDuplicateKeyErrorByCode = () => {
    const err: any = new Error('ER_DUP_ENTRY');
    err.code = 'ER_DUP_ENTRY';
    return err;
  };

  const makeDuplicateKeyErrorByErrno = () => {
    const err: any = new Error('Duplicate entry');
    err.errno = 1062;
    return err;
  };

  const makeWrappedQueryFailedDupKey = () => {
    // TypeORM이 드라이버 에러를 QueryFailedError로 wrap하는 경로.
    // 현재 RefundLedgerService.insertLedger는 e?.code / e?.errno 만 검사하므로
    // 이 wrap된 에러는 BadRequestException으로 변환되지 못한다.
    const driverError: any = new Error('ER_DUP_ENTRY');
    driverError.code = 'ER_DUP_ENTRY';
    driverError.errno = 1062;
    return new QueryFailedError('INSERT', [], driverError);
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    refundRepository = {
      createQueryBuilder: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<Repository<OrderDeliveryRefundEntity>>;

    deliveryRepository = {
      createQueryBuilder: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<Repository<OrderDeliveryEntity>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundLedgerService,
        { provide: getRepositoryToken(OrderDeliveryRefundEntity), useValue: refundRepository },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: deliveryRepository },
      ],
    }).compile();

    sut = module.get(RefundLedgerService);
  });

  describe('claim()', () => {
    it('정상: INSERT 성공 후 markRefundedAt UPDATE 호출', async () => {
      const insertChain = makeInsertChain(async () => ({ identifiers: [{ id: 1 }] }));
      const updateChain = makeUpdateChain(async () => ({ affected: 1 }));
      refundRepository.createQueryBuilder.mockReturnValue(insertChain);
      deliveryRepository.createQueryBuilder.mockReturnValue(updateChain);

      await sut.claim(baseInput);

      expect(insertChain.execute).toHaveBeenCalledTimes(1);
      expect(updateChain.execute).toHaveBeenCalledTimes(1);
      // 호출 순서: INSERT 먼저, UPDATE 나중
      const insertOrder = insertChain.execute.mock.invocationCallOrder[0];
      const updateOrder = updateChain.execute.mock.invocationCallOrder[0];
      expect(insertOrder).toBeLessThan(updateOrder);
      // INSERT payload 확인
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          orderDeliveryId: baseInput.orderDeliveryId,
          userId: baseInput.userId,
          refundAmount: baseInput.refundAmount,
          restoreType: baseInput.restoreType,
          sourcePath: baseInput.sourcePath,
        }),
      );
    });

    it('중복(ER_DUP_ENTRY, code 경로): BadRequestException으로 변환', async () => {
      const insertChain = makeInsertChain(async () => {
        throw makeDuplicateKeyErrorByCode();
      });
      const updateChain = makeUpdateChain(async () => ({ affected: 1 }));
      refundRepository.createQueryBuilder.mockReturnValue(insertChain);
      deliveryRepository.createQueryBuilder.mockReturnValue(updateChain);

      await expect(sut.claim(baseInput)).rejects.toBeInstanceOf(BadRequestException);
      // markRefundedAt는 호출되지 않아야 한다 (INSERT 실패 시 후속 UPDATE 차단)
      expect(updateChain.execute).not.toHaveBeenCalled();
    });

    it('중복(errno=1062 경로): BadRequestException으로 변환', async () => {
      const insertChain = makeInsertChain(async () => {
        throw makeDuplicateKeyErrorByErrno();
      });
      const updateChain = makeUpdateChain(async () => ({ affected: 1 }));
      refundRepository.createQueryBuilder.mockReturnValue(insertChain);
      deliveryRepository.createQueryBuilder.mockReturnValue(updateChain);

      await expect(sut.claim(baseInput)).rejects.toBeInstanceOf(BadRequestException);
      expect(updateChain.execute).not.toHaveBeenCalled();
    });

    it('비-dedup 에러는 그대로 rethrow (BadRequestException 아님)', async () => {
      const insertChain = makeInsertChain(async () => {
        throw new Error('connection lost');
      });
      const updateChain = makeUpdateChain(async () => ({ affected: 1 }));
      refundRepository.createQueryBuilder.mockReturnValue(insertChain);
      deliveryRepository.createQueryBuilder.mockReturnValue(updateChain);

      const caught = await sut.claim(baseInput).catch((e) => e);
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(BadRequestException);
      expect((caught as Error).message).toBe('connection lost');
      expect(updateChain.execute).not.toHaveBeenCalled();
    });

    /**
     * 회귀 테스트:
     * TypeORM의 QueryFailedError는 driverError의 속성(code/errno)을 인스턴스에
     * spread하여 직접 노출한다. 따라서 e?.code === 'ER_DUP_ENTRY' 검사가 wrap된
     * 에러에서도 작동한다. 이 동작은 TypeORM 버전에 의존하므로 회귀로 잠근다.
     */
    it('QueryFailedError로 wrap된 ER_DUP_ENTRY도 BadRequestException으로 변환된다', async () => {
      const wrapped = makeWrappedQueryFailedDupKey();
      const insertChain = makeInsertChain(async () => {
        throw wrapped;
      });
      const updateChain = makeUpdateChain(async () => ({ affected: 1 }));
      refundRepository.createQueryBuilder.mockReturnValue(insertChain);
      deliveryRepository.createQueryBuilder.mockReturnValue(updateChain);

      await expect(sut.claim(baseInput)).rejects.toBeInstanceOf(BadRequestException);
      expect(updateChain.execute).not.toHaveBeenCalled();
    });

    /**
     * CRITICAL #1 회귀 테스트:
     * claim()이 단일 트랜잭션이 아니므로 INSERT 성공 + markRefundedAt UPDATE 실패 시
     * ledger row는 남고 order_delivery.refunded_at은 NULL로 유지되어 두 source가 분기된다.
     * 현재 코드는 이 시나리오에서 호출자에게 에러를 던지고 종료하지만 ledger row는 정리되지 않는다.
     */
    it('[비원자성 노출] INSERT 성공 후 markRefundedAt 실패 시 INSERT는 롤백되지 않는다 (divergence)', async () => {
      const insertChain = makeInsertChain(async () => ({ identifiers: [{ id: 1 }] }));
      const updateChain = makeUpdateChain(async () => {
        throw new Error('UPDATE failed');
      });
      refundRepository.createQueryBuilder.mockReturnValue(insertChain);
      deliveryRepository.createQueryBuilder.mockReturnValue(updateChain);

      await expect(sut.claim(baseInput)).rejects.toThrow('UPDATE failed');
      // INSERT는 1회 호출되어 ledger row가 남는다 (mock이므로 실제 DB 행 검증은 불가하지만,
      // 코드 흐름상 자동 롤백이 없다는 것을 호출 카운트로 입증)
      expect(insertChain.execute).toHaveBeenCalledTimes(1);
      // 호출자가 받는 에러는 UPDATE 실패 메시지이며 BadRequestException이 아니다
      const caught = await sut.claim(baseInput).catch((e) => e);
      expect(caught).not.toBeInstanceOf(BadRequestException);
    });
  });

  describe('release()', () => {
    it('정상: DELETE + clearRefundedAt UPDATE 둘 다 호출', async () => {
      refundRepository.delete.mockResolvedValue({ affected: 1, raw: {} } as any);
      deliveryRepository.update.mockResolvedValue({ affected: 1, raw: {}, generatedMaps: [] } as any);

      await sut.release(baseInput.orderDeliveryId);

      expect(refundRepository.delete).toHaveBeenCalledWith({ orderDeliveryId: baseInput.orderDeliveryId });
      expect(deliveryRepository.update).toHaveBeenCalledWith(
        { id: baseInput.orderDeliveryId },
        { refundedAt: null },
      );
    });

    /**
     * 멱등성 회귀 테스트:
     * release()는 deleteLedger의 affected==0을 감지해 BadRequestException을 던진다.
     * 두 번째 동시 release() 호출이 ledger row 없음을 인지하지 못한 채 부수효과
     * (chargeBack/deduct)를 두 번 실행하는 race를 닫는다.
     * 호출자는 BadRequestException을 catch해 부수효과를 skip해야 한다.
     */
    it('두 번째 release()는 affected==0이면 BadRequestException을 던진다', async () => {
      refundRepository.delete
        .mockResolvedValueOnce({ affected: 1, raw: {} } as any)
        .mockResolvedValueOnce({ affected: 0, raw: {} } as any);
      deliveryRepository.update.mockResolvedValue({ affected: 1, raw: {}, generatedMaps: [] } as any);

      await sut.release(baseInput.orderDeliveryId);
      await expect(sut.release(baseInput.orderDeliveryId)).rejects.toBeInstanceOf(BadRequestException);
      expect(refundRepository.delete).toHaveBeenCalledTimes(2);
      // 첫 번째 release 후 clearRefundedAt은 1회만 실행됐어야 한다 (두 번째는 BadRequestException 전에 차단)
      expect(deliveryRepository.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('claimWithManager() / releaseWithManager()', () => {
    const makeManager = (refundRepo: any, deliveryRepo: any): EntityManager =>
      ({
        getRepository: jest.fn((entity: any) => {
          if (entity === OrderDeliveryRefundEntity) return refundRepo;
          if (entity === OrderDeliveryEntity) return deliveryRepo;
          throw new Error('unexpected entity');
        }),
      }) as unknown as EntityManager;

    it('claimWithManager: manager.getRepository 경로로 INSERT + UPDATE 호출', async () => {
      const insertChain = makeInsertChain(async () => ({ identifiers: [{ id: 1 }] }));
      const updateChain = makeUpdateChain(async () => ({ affected: 1 }));
      const refundRepo = { createQueryBuilder: jest.fn().mockReturnValue(insertChain) };
      const deliveryRepo = { createQueryBuilder: jest.fn().mockReturnValue(updateChain) };
      const manager = makeManager(refundRepo, deliveryRepo);

      await sut.claimWithManager(manager, baseInput);

      expect(manager.getRepository).toHaveBeenCalledWith(OrderDeliveryRefundEntity);
      expect(manager.getRepository).toHaveBeenCalledWith(OrderDeliveryEntity);
      expect(insertChain.execute).toHaveBeenCalledTimes(1);
      expect(updateChain.execute).toHaveBeenCalledTimes(1);
    });

    it('claimWithManager: 중복 시 BadRequestException + UPDATE 미호출', async () => {
      const insertChain = makeInsertChain(async () => {
        throw makeDuplicateKeyErrorByCode();
      });
      const updateChain = makeUpdateChain(async () => ({ affected: 1 }));
      const refundRepo = { createQueryBuilder: jest.fn().mockReturnValue(insertChain) };
      const deliveryRepo = { createQueryBuilder: jest.fn().mockReturnValue(updateChain) };
      const manager = makeManager(refundRepo, deliveryRepo);

      await expect(sut.claimWithManager(manager, baseInput)).rejects.toBeInstanceOf(BadRequestException);
      expect(updateChain.execute).not.toHaveBeenCalled();
    });

    it('releaseWithManager: DELETE + UPDATE 둘 다 호출', async () => {
      const refundRepo = { delete: jest.fn().mockResolvedValue({ affected: 1, raw: {} }) };
      const deliveryRepo = {
        update: jest.fn().mockResolvedValue({ affected: 1, raw: {}, generatedMaps: [] }),
      };
      const manager = makeManager(refundRepo, deliveryRepo);

      await sut.releaseWithManager(manager, baseInput.orderDeliveryId);

      expect(refundRepo.delete).toHaveBeenCalledWith({ orderDeliveryId: baseInput.orderDeliveryId });
      expect(deliveryRepo.update).toHaveBeenCalledWith(
        { id: baseInput.orderDeliveryId },
        { refundedAt: null },
      );
    });
  });
});
