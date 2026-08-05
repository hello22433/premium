import { ObjectLiteral, Repository } from 'typeorm';

/**
 * 정산 도메인 전용 raw INSERT.
 *
 * TypeORM 엔티티 insert 를 쓰지 않는 이유는 하나다 — datetime 컬럼 값을 `Date` 로 정규화하면서
 * `.123456` 을 `.123000` 으로 깎기 때문이다(`DateUtils.mixedDateToDate`). 정산 시각은 증적이라
 * canonical `DATETIME(6)` 문자열을 그대로 바인딩해야 한다.
 *
 * 컬럼 목록과 값 목록을 같은 객체에서 뽑으므로 개수가 어긋날 수 없다.
 */
export type RawRow = Record<string, string | number | null>;

const MYSQL_DUPLICATE_ENTRY = 1062;

export async function insertRawRow<T extends ObjectLiteral>(
  repository: Repository<T>,
  table: string,
  row: RawRow,
): Promise<{ duplicated: boolean }> {
  const columns = Object.keys(row);
  const sql =
    `INSERT INTO ${table} (${columns.map((column) => `\`${column}\``).join(', ')})` +
    ` VALUES (${columns.map(() => '?').join(', ')})`;

  try {
    await repository.query(
      sql,
      columns.map((column) => row[column]),
    );
    return { duplicated: false };
  } catch (error) {
    // 동시 수신 2건이 같은 사건을 집으면 한쪽이 UNIQUE 에 걸린다. 그건 정상이고 기존 row 가 답이다.
    if (!isDuplicateKeyError(error)) throw error;
    return { duplicated: true };
  }
}

export function isDuplicateKeyError(error: unknown): boolean {
  const errno =
    (error as { driverError?: { errno?: number }; errno?: number })?.driverError?.errno ??
    (error as { errno?: number })?.errno;
  return errno === MYSQL_DUPLICATE_ENTRY;
}
