import { AdjustmentProposalController } from './adjustment.proposal.controller';
import { retryOnLockConflict, isLockConflictError } from '../domain/lock.retry';

describe('AdjustmentProposalController', () => {
  let controller: AdjustmentProposalController;
  let proposalService: any;
  let authService: any;
  const user = { id: 10, email: 'test@test.com' } as any;

  beforeEach(() => {
    proposalService = {
      findProposals: jest.fn().mockResolvedValue([]),
      createManual: jest.fn().mockResolvedValue({ id: 1 }),
      approve: jest.fn().mockResolvedValue({ proposals: [], ledgerIds: [] }),
      reject: jest.fn().mockResolvedValue({ proposals: [] }),
    };
    authService = {
      authorityValidator: jest.fn().mockResolvedValue(undefined),
    };
    controller = new AdjustmentProposalController(proposalService, authService);
  });

  it('findProposals 호출', async () => {
    await controller.findProposals(user, {} as any);
    expect(proposalService.findProposals).toHaveBeenCalled();
  });

  it('create 호출', async () => {
    await controller.create(user, { partnerCompanyId: 7, subItemKey: 'NONE', amount: '200', reason: 'x', requestKey: 'r1' } as any);
    expect(proposalService.createManual).toHaveBeenCalled();
  });

  it('approve 호출', async () => {
    await controller.approve(user, 1, {} as any);
    expect(proposalService.approve).toHaveBeenCalledWith(1, {}, expect.objectContaining({ id: 10 }));
  });

  it('reject 호출', async () => {
    await controller.reject(user, 1, { reason: '반려' } as any);
    expect(proposalService.reject).toHaveBeenCalledWith(1, { reason: '반려' }, expect.objectContaining({ id: 10 }));
  });

  it('approve 락 충돌 시 재시도 후 성공', async () => {
    const deadlockError: any = new Error('deadlock');
    deadlockError.driverError = { errno: 1213 };

    let callCount = 0;
    proposalService.approve.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw deadlockError;
      return { proposals: [], ledgerIds: [] };
    });

    await controller.approve(user, 1, {} as any);
    expect(callCount).toBe(2);
  });

  it('reject 락 충돌 시 재시도 후 성공', async () => {
    const deadlockError: any = new Error('deadlock');
    deadlockError.driverError = { errno: 1213 };

    let callCount = 0;
    proposalService.reject.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw deadlockError;
      return { proposals: [] };
    });

    await controller.reject(user, 1, { reason: 'x' } as any);
    expect(callCount).toBe(2);
  });

  it('create 락 충돌 시 재시도 후 성공', async () => {
    const deadlockError: any = new Error('deadlock');
    deadlockError.driverError = { errno: 1213 };

    let callCount = 0;
    proposalService.createManual.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw deadlockError;
      return { id: 1 };
    });

    await controller.create(user, { partnerCompanyId: 7, subItemKey: 'NONE', amount: '200', reason: 'x', requestKey: 'r1' } as any);
    expect(callCount).toBe(2);
  });

  it('취소/수정 endpoint 부재 확인 (controller 에 해당 메서드 없음)', () => {
    expect((controller as any).cancel).toBeUndefined();
    expect((controller as any).update).toBeUndefined();
    expect((controller as any).edit).toBeUndefined();
    expect((controller as any).delete).toBeUndefined();
  });
});

describe('retryOnLockConflict', () => {
  it('락 충돌 시 재시도 후 성공', async () => {
    let attempt = 0;
    const result = await retryOnLockConflict(
      async () => {
        attempt++;
        if (attempt < 2) {
          const err: any = new Error('deadlock');
          err.driverError = { errno: 1213 };
          throw err;
        }
        return 'ok';
      },
      { maxAttempts: 3, backoffMs: 1 },
    );
    expect(result).toBe('ok');
    expect(attempt).toBe(2);
  });

  it('비 락 오류는 재시도 없이 throw', async () => {
    await expect(
      retryOnLockConflict(
        async () => { throw new Error('not a lock error'); },
        { maxAttempts: 3, backoffMs: 1 },
      ),
    ).rejects.toThrow('not a lock error');
  });

  it('isLockConflictError: deadlock=1213', () => {
    const err: any = new Error();
    err.driverError = { errno: 1213 };
    expect(isLockConflictError(err)).toBe(true);
  });

  it('isLockConflictError: lock wait timeout=1205', () => {
    const err: any = new Error();
    err.driverError = { errno: 1205 };
    expect(isLockConflictError(err)).toBe(true);
  });

  it('isLockConflictError: 일반 에러=false', () => {
    expect(isLockConflictError(new Error())).toBe(false);
  });
});
