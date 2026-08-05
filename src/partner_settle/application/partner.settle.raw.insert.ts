import { ObjectLiteral, Repository } from 'typeorm';

/**
 * 정산 도메인 전용 raw INSERT.
 *
 * TypeORM 엔티티 insert 를 쓰지 않는 이유는 하나다 — datetime 컬럼 값을 `Date` 로 정규화하면서
 * `.123456` 을 `.123000` 으로 깎기 때문이다(`DateUtils.mixedDateToDate`). 정산 시각은 증적이라
 * canonical `DATETIME(6)` 문자열을 그대로 바인딩해야 한다.
 *
 * 컬럼 목록과 값 목록을 같은 객체에서 뽑으므로 개수가 어긋날 수 없다.
 *
 * duplicate(1062) 는 **제약 이름별로 의미가 다르다**. 정산 테이블은 멱등키 외에도 전이 순번·orphan
 * ingress UNIQUE 를 갖는데, 그 충돌은 "같은 사건 재수신"이 아니라 서로 다른 사건이 같은 슬롯을 노린
 * 대사 오류다. 멱등 수렴으로 삼키면 원인 없이 500 만 남으므로, 호출부가 **멱등으로 취급할 제약을
 * 명시**해야 하고 그 외 제약 충돌은 원본 에러 그대로 전파한다.
 */
export type RawRow = Record<string, string | number | null>;

const MYSQL_DUPLICATE_ENTRY = 1062;

export type InsertRawRowOptions = {
  /** 이 제약 충돌만 "이미 같은 사건이 있다"로 본다. 나머지 1062 는 throw. */
  idempotentConstraints: readonly string[];
};

export type InsertRawRowResult = {
  duplicated: boolean;
  /** duplicated 일 때 충돌한 UNIQUE 제약 이름 */
  constraint: string | null;
};

export async function insertRawRow<T extends ObjectLiteral>(
  repository: Repository<T>,
  table: string,
  row: RawRow,
  options: InsertRawRowOptions,
): Promise<InsertRawRowResult> {
  const columns = Object.keys(row);
  const sql =
    `INSERT INTO ${table} (${columns.map((column) => `\`${column}\``).join(', ')})` +
    ` VALUES (${columns.map(() => '?').join(', ')})`;

  try {
    await repository.query(
      sql,
      columns.map((column) => row[column]),
    );
    return { duplicated: false, constraint: null };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    // 동시 수신 2건이 같은 사건을 집으면 한쪽이 UNIQUE 에 걸린다. 그건 정상이고 기존 row 가 답이다.
    // 단, 그 판단은 호출부가 지정한 제약에서만 성립한다. 이름을 못 읽으면 삼키지 않는다.
    const constraint = duplicateKeyConstraint(error);
    if (constraint === null || !options.idempotentConstraints.includes(constraint)) throw error;

    return { duplicated: true, constraint };
  }
}

export function isDuplicateKeyError(error: unknown): boolean {
  const errno =
    (error as { driverError?: { errno?: number }; errno?: number })?.driverError?.errno ??
    (error as { errno?: number })?.errno;
  return errno === MYSQL_DUPLICATE_ENTRY;
}

/**
 * 1062 메시지에서 충돌 제약 이름을 뽑는다.
 * MySQL 8 은 `for key 'tbl.uk_name'`, 5.7 은 `for key 'uk_name'` 으로 준다 — 마지막 `.` 뒤를 쓴다.
 */
export function duplicateKeyConstraint(error: unknown): string | null {
  const message =
    (error as { driverError?: { sqlMessage?: string }; sqlMessage?: string })?.driverError?.sqlMessage ??
    (error as { sqlMessage?: string })?.sqlMessage ??
    (error as { message?: string })?.message;

  const matched = typeof message === 'string' ? /for key '([^']+)'/.exec(message) : null;
  if (!matched) return null;

  const key = matched[1];
  return key.slice(key.lastIndexOf('.') + 1);
}
