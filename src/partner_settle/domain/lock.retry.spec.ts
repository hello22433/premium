import { isLockConflictError, retryOnLockConflict } from './lock.retry';

function lockError(errno: number) {
  return Object.assign(new Error('lock'), { driverError: { errno } });
}

describe('isLockConflictError', () => {
  it('데드락과 락 대기 초과만 재시도 대상으로 본다', () => {
    expect(isLockConflictError(lockError(1213))).toBe(true);
    expect(isLockConflictError(lockError(1205))).toBe(true);
    expect(isLockConflictError(lockError(1062))).toBe(false); // 중복키는 재시도해도 같은 결과다
    expect(isLockConflictError(new Error('boom'))).toBe(false);
  });

  it('driverError 로 감싸이지 않은 errno 도 인식한다', () => {
    expect(isLockConflictError(Object.assign(new Error('lock'), { errno: 1213 }))).toBe(true);
  });
});

describe('retryOnLockConflict', () => {
  it('데드락이면 다시 시도한다', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(lockError(1213))
      .mockResolvedValueOnce('ok');

    await expect(retryOnLockConflict(operation, { backoffMs: 1 })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('최대 시도 횟수를 넘기면 마지막 오류를 그대로 올린다', async () => {
    const operation = jest.fn().mockRejectedValue(lockError(1205));

    await expect(retryOnLockConflict(operation, { maxAttempts: 3, backoffMs: 1 })).rejects.toThrow('lock');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('락 충돌이 아니면 재시도하지 않는다', async () => {
    // 검증 실패를 재시도하면 사용자에게 응답이 늦어질 뿐 결과가 달라지지 않는다.
    const operation = jest.fn().mockRejectedValue(new BadRequest());

    await expect(retryOnLockConflict(operation, { backoffMs: 1 })).rejects.toBeInstanceOf(BadRequest);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('성공하면 한 번만 부른다', async () => {
    const operation = jest.fn().mockResolvedValue(1);

    await expect(retryOnLockConflict(operation)).resolves.toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

class BadRequest extends Error {}
