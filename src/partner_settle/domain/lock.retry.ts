/**
 * 정책 잠금 경로의 데드락·락 대기 초과 재시도.
 *
 * 협력사 정산조건 쓰기는 epoch → policyTargetKey → scopeKey 순으로 여러 행을 잡는다. 순서를 고정해도
 * InnoDB 는 갭 락·인덱스 순회 차이로 데드락을 낼 수 있고, 그때 MySQL 이 죽이는 쪽은 우리가 고르지 못한다.
 * 재시도가 없으면 정상 요청이 사용자에게 500 으로 나간다.
 *
 * **트랜잭션 밖에서 감싸야 한다.** 데드락으로 죽은 트랜잭션은 이미 롤백된 상태라 그 안에서 다시 시도해도
 * 소용이 없다. 호출 형태는 `retryOnLockConflict(() => this.doSomethingTransactional(...))` 이다.
 */

const MYSQL_DEADLOCK = 1213; // ER_LOCK_DEADLOCK
const MYSQL_LOCK_WAIT_TIMEOUT = 1205; // ER_LOCK_WAIT_TIMEOUT

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 50;

export type LockRetryOptions = {
  maxAttempts?: number;
  backoffMs?: number;
};

export function isLockConflictError(error: unknown): boolean {
  const errno = (error as { driverError?: { errno?: number }; errno?: number })?.driverError?.errno
    ?? (error as { errno?: number })?.errno;

  return errno === MYSQL_DEADLOCK || errno === MYSQL_LOCK_WAIT_TIMEOUT;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function retryOnLockConflict<T>(operation: () => Promise<T>, options: LockRetryOptions = {}): Promise<T> {
  const maxAttempts =
    options.maxAttempts ?? readPositiveInt(process.env.PARTNER_DISCOUNT_LOCK_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
  const backoffMs =
    options.backoffMs ?? readPositiveInt(process.env.PARTNER_DISCOUNT_LOCK_BACKOFF_MS, DEFAULT_BACKOFF_MS);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      // 락 충돌이 아니면 재시도가 의미 없고, 검증 실패를 삼키면 안 된다.
      if (attempt >= maxAttempts || !isLockConflictError(error)) {
        throw error;
      }
      // 지수 백오프. 같은 간격으로 재시도하면 충돌한 두 트랜잭션이 계속 같이 부딪힌다.
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
