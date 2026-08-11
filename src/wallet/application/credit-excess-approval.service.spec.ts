import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CreditExcessApprovalService } from './credit-excess-approval.service';
import { CreditExcessApprovalClaimConflictError, CreditExcessApprovalDriftError } from './credit-excess-approval.errors';
import { CreditExcessApprovalStatus } from '../../entity/credit.excess.approval.entity';

/**
 * [EP-P23] 승인 상태 저장소.
 * CAS 선점 / fencing token 검증 / 실행 표식 기반 최종화·복구 규칙 검증.
 */
describe('CreditExcessApprovalService', () => {
  const updateQb = (affected: number) => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected }),
  });

  const makeService = ({
    approval,
    affected = 1,
    execution = null,
  }: {
    approval?: Record<string, unknown> | null;
    affected?: number;
    execution?: Record<string, unknown> | null;
  }) => {
    const updateBuilder = updateQb(affected);
    const approvalRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(updateBuilder),
      findOne: jest.fn().mockResolvedValue(approval ?? null),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      find: jest.fn().mockResolvedValue([]),
    } as any;
    const executionRepository = {
      findOne: jest.fn().mockResolvedValue(execution),
      create: jest.fn((v: unknown) => v),
      insert: jest.fn().mockResolvedValue(undefined),
    } as any;
    const userRepository = { find: jest.fn().mockResolvedValue([]) } as any;

    const lockedQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(approval ?? null),
    };
    const manager = {
      getRepository: jest.fn((entity: any) =>
        String(entity?.name ?? '').includes('Execution')
          ? executionRepository
          : { ...approvalRepository, createQueryBuilder: jest.fn().mockReturnValue({ ...lockedQb, ...updateBuilder }) },
      ),
    } as any;
    const dataSource = { transaction: jest.fn(async (cb: any) => cb(manager)) } as any;

    const service = new CreditExcessApprovalService(
      approvalRepository,
      executionRepository,
      userRepository,
      dataSource,
    );
    return { service, approvalRepository, executionRepository, updateBuilder, manager, lockedQb };
  };

  const pending = {
    id: '900',
    orderId: 77,
    status: CreditExcessApprovalStatus.PENDING,
    attemptToken: null,
    requestedAmount: 10000,
    requestedCreditExcessAmount: 3000,
    consumedAt: null,
    leaseExpiresAt: null,
  };

  describe('createPending', () => {
    it('같은 주문의 활성 요청이 있으면 거절한다', async () => {
      const { service, manager } = makeService({ approval: pending });
      manager.getRepository = jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue(pending),
        save: jest.fn(),
        create: jest.fn(),
      });

      await expect(
        service.createPending(
          {
            orderId: 77,
            walletAccountId: 'w-1',
            requestedAmount: 10000,
            requestedCreditExcessAmount: 3000,
            reasonText: '사유',
            requestedBy: 2,
            snapshotVersion: 1,
            snapshot: {},
          },
          manager,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('DB unique 위반(동시 생성)도 사용자 메시지로 변환한다', async () => {
      const { service, manager } = makeService({ approval: null });
      const dupError = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      manager.getRepository = jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((v: unknown) => v),
        save: jest.fn().mockRejectedValue(dupError),
      });

      await expect(
        service.createPending(
          {
            orderId: 77,
            walletAccountId: 'w-1',
            requestedAmount: 10000,
            requestedCreditExcessAmount: 3000,
            reasonText: '사유',
            requestedBy: 2,
            snapshotVersion: 1,
            snapshot: {},
          },
          manager,
        ),
      ).rejects.toThrow('이미 처리 중인 신용초과 승인 요청이 있습니다.');
    });

    it('사유가 비어 있으면 거절한다', async () => {
      const { service, manager } = makeService({ approval: null });
      await expect(
        service.createPending(
          {
            orderId: 77,
            walletAccountId: null,
            requestedAmount: 10000,
            requestedCreditExcessAmount: 3000,
            reasonText: '   ',
            requestedBy: 2,
            snapshotVersion: 1,
            snapshot: {},
          },
          manager,
        ),
      ).rejects.toThrow('요청 사유를 입력해 주세요.');
    });
  });

  describe('claimForProcessing', () => {
    it('PENDING 선점 성공 시 새 fencing token 을 발급한다', async () => {
      const { service, approvalRepository } = makeService({ approval: pending, affected: 1 });
      approvalRepository.findOne.mockResolvedValue({
        ...pending,
        status: CreditExcessApprovalStatus.PROCESSING,
      });

      const { attemptToken } = await service.claimForProcessing('900', 9);

      expect(attemptToken).toMatch(/^[0-9a-f]{48}$/);
    });

    it('이미 선점된 요청은 conflict 로 던지고 최신 상태를 실어 준다 (멱등 응답용)', async () => {
      const { service, approvalRepository } = makeService({ approval: pending, affected: 0 });
      approvalRepository.findOne.mockResolvedValue({
        ...pending,
        status: CreditExcessApprovalStatus.PROCESSING,
      });

      await expect(service.claimForProcessing('900', 9)).rejects.toBeInstanceOf(
        CreditExcessApprovalClaimConflictError,
      );
      await expect(service.claimForProcessing('900', 9)).rejects.toMatchObject({
        current: { status: CreditExcessApprovalStatus.PROCESSING },
      });
    });
  });

  describe('lockProcessing', () => {
    it('토큰이 다르면 실행을 거절한다', async () => {
      const { service, manager, lockedQb } = makeService({ approval: null });
      lockedQb.getOne.mockResolvedValue({
        ...pending,
        status: CreditExcessApprovalStatus.PROCESSING,
        attemptToken: 'other',
      });
      manager.getRepository = jest.fn().mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(lockedQb) });

      await expect(service.lockProcessing(manager, '900', 'token-abc')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('consume', () => {
    const processing = {
      ...pending,
      status: CreditExcessApprovalStatus.PROCESSING,
      attemptToken: 'token-abc',
    };

    const managerFor = (approval: unknown, affected = 1) => {
      const builder = updateQb(affected);
      return {
        getRepository: jest.fn().mockReturnValue({
          findOne: jest.fn().mockResolvedValue(approval),
          createQueryBuilder: jest.fn().mockReturnValue(builder),
        }),
      } as any;
    };

    it('금액이 달라지면 재요청 대상(drift)으로 분류한다', async () => {
      const { service } = makeService({ approval: processing });

      await expect(service.consume('900', 77, 4000, 10000, managerFor(processing))).rejects.toBeInstanceOf(
        CreditExcessApprovalDriftError,
      );
    });

    it('PROCESSING 이 아니면 소비하지 않는다', async () => {
      const { service } = makeService({ approval: pending });

      await expect(service.consume('900', 77, 3000, 10000, managerFor(pending))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('조건부 UPDATE 가 0행이면 중복 사용으로 차단한다', async () => {
      const { service } = makeService({ approval: processing });

      await expect(service.consume('900', 77, 3000, 10000, managerFor(processing, 0))).rejects.toThrow(
        'approval consume race (already used)',
      );
    });
  });

  describe('finalizeFailure', () => {
    it('실행 표식이 이미 있으면 실패로 덮어쓰지 않는다', async () => {
      const { service, executionRepository, manager } = makeService({
        approval: pending,
        execution: { id: '1', approvalId: '900', attemptToken: 'token-abc' },
      });
      const updateSpy = updateQb(1);
      manager.getRepository = jest.fn((entity: any) =>
        String(entity?.name ?? '').includes('Execution')
          ? executionRepository
          : { createQueryBuilder: jest.fn().mockReturnValue(updateSpy) },
      );

      await service.finalizeFailure({
        approvalId: '900',
        attemptToken: 'token-abc',
        status: CreditExcessApprovalStatus.FAILED,
        diagnosticCode: 'DISPATCH_FAILED',
        userMessage: '실패',
        changedFields: null,
        internalReason: 'boom',
      });

      expect(updateSpy.execute).not.toHaveBeenCalled();
    });
  });

  describe('recordExecution', () => {
    it('같은 승인의 실행 표식은 1건만 허용한다 (중복 발송 차단)', async () => {
      const { service } = makeService({ approval: pending });
      const dupError = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      const manager = {
        getRepository: jest.fn().mockReturnValue({
          create: jest.fn((v: unknown) => v),
          insert: jest.fn().mockRejectedValue(dupError),
        }),
      } as any;

      await expect(
        service.recordExecution(manager, {
          approvalId: '900',
          orderId: 77,
          attemptToken: 'token-abc',
          lifecycleMode: 'WALLET',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('recoverExpired', () => {
    const expiredProcessing = {
      ...pending,
      status: CreditExcessApprovalStatus.PROCESSING,
      attemptToken: 'token-abc',
      leaseExpiresAt: new Date(Date.now() - 60_000),
    };

    const recoveryService = (execution: Record<string, unknown> | null) => {
      const updateBuilder = updateQb(1);
      const executionRepository = {
        findOne: jest.fn().mockResolvedValue(execution),
        create: jest.fn(),
        insert: jest.fn(),
      } as any;
      const lockedQb = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(expiredProcessing),
      };
      const approvalRepo = {
        createQueryBuilder: jest.fn().mockReturnValueOnce(lockedQb).mockReturnValue(updateBuilder),
      };
      const manager = {
        getRepository: jest.fn((entity: any) =>
          String(entity?.name ?? '').includes('Execution') ? executionRepository : approvalRepo,
        ),
      } as any;
      const dataSource = { transaction: jest.fn(async (cb: any) => cb(manager)) } as any;
      return new CreditExcessApprovalService({} as any, executionRepository, {} as any, dataSource);
    };

    it('동일 토큰 실행 표식이 있으면 COMPLETED 로 수렴한다 (재발송 금지)', async () => {
      const service = recoveryService({ id: '1', approvalId: '900', attemptToken: 'token-abc' });

      await expect(service.recoverExpired('900')).resolves.toBe(CreditExcessApprovalStatus.COMPLETED);
    });

    it('실행 표식이 없으면 FAILED 로 전이한다', async () => {
      const service = recoveryService(null);

      await expect(service.recoverExpired('900')).resolves.toBe(CreditExcessApprovalStatus.FAILED);
    });
  });
});
