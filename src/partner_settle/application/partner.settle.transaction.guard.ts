import { EntityManager, ObjectLiteral, Repository } from 'typeorm';

/**
 * 정산 원장 경로의 트랜잭션 선행조건 가드.
 *
 * 원장 append 는 **원천 상태 갱신과 같은 트랜잭션 안에서만** 유효하다. 여기서 스스로
 * `@Transactional()` 로 트랜잭션을 열면 안 된다 — 그러면 원천 상태만 롤백되고 원장은 남거나,
 * 반대로 상태는 USED 인데 원장이 없는 창이 생긴다. 열지 않고 **없으면 즉시 깨뜨린다**.
 *
 * 잠금도 같은 이유로 트랜잭션이 필요하다.
 * - `setLock('pessimistic_write')` 는 비트랜잭션이면 TypeORM 이 쿼리 자체를 거부한다.
 * - raw `SELECT ... FOR UPDATE` 는 autocommit 에서 **조용히 무력화**된다(에러 없이 락 미보유).
 * 후자가 더 위험하므로 호출 시점에 명시적으로 검사한다.
 *
 * `typeorm-transactional` 이 CLS 트랜잭션 안에서 repository 의 manager 를 그 트랜잭션의
 * manager 로 바꿔치기하므로, ambient 트랜잭션 여부는 manager 의 queryRunner 로 판정한다
 * (관례: `refund-ledger.service.ts` claim()).
 */
export class MissingTransactionError extends Error {
  constructor(operation: string) {
    super(
      `${operation} 은(는) 원천 상태 갱신과 같은 트랜잭션 안에서만 호출할 수 있습니다. ` +
        '호출부를 @Transactional() 로 감싸십시오.',
    );
  }
}

export function assertInTransaction<T extends ObjectLiteral>(
  source: Repository<T> | EntityManager,
  operation: string,
): void {
  const manager = source instanceof EntityManager ? source : source.manager;
  if (!manager?.queryRunner?.isTransactionActive) {
    throw new MissingTransactionError(operation);
  }
}
