import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { createTempOrderCode, deriveOrderCodeFromId } from './order.code';

dotenv.config();

jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;
const database = process.env.DATABASE_DATABASE;
const describeDb = database && TEST_DB_NAME_PATTERN.test(database) ? describe : describe.skip;

/**
 * D3-51 id 파생 2-step 채번의 실 MySQL 무결성 검증.
 *
 * 단위 spec은 트랜잭션이 stub이라 "임시코드는 커밋 전 소멸" 불변식을 검증하지 못한다(리뷰 F1).
 * 본 통합테스트는 실 MySQL에서 3가지를 실측한다:
 *   1) happy: 임시코드(TMP-)가 확정 EPEVT 코드로 교체되고 TMP- 잔여 0
 *   2) rollback: 트랜잭션 롤백 시 임시코드 행이 커밋되지 않음(F1 불변식)
 *   3) 동시성: 동시 채번 시 전부 고유 EPEVT 코드, 충돌·TMP- 잔여 0(F4)
 *
 * 서비스(@Transactional) 전체 그래프가 아니라 order.code 컬럼의 2-step 메커니즘 + 실 헬퍼를
 * auto_increment PK + UNIQUE(code) 를 모사한 전용 테이블에서 검증한다(order FK 의존 배제).
 * DATABASE_DATABASE 이름에 test가 없으면 skip(기존 *.db-integration-test 규약과 동일).
 */
describeDb('order.code 2-step 채번 DB integration (D3-51)', () => {
  const TABLE = 'd3_51_order_code_it';
  let pool: mysql.Pool;

  beforeAll(async () => {
    pool = mysql.createPool({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: database!,
      connectionLimit: 10,
      waitForConnections: true,
    });
    await pool.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
    await pool.query(
      `CREATE TABLE \`${TABLE}\` (\`id\` BIGINT NOT NULL AUTO_INCREMENT, \`code\` VARCHAR(256) NOT NULL, PRIMARY KEY(\`id\`), UNIQUE KEY \`uk_code\`(\`code\`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE \`${TABLE}\``);
  });

  // 서비스의 insert 기반 2-step(createTemp)과 동일 메커니즘 — 실 헬퍼 사용
  async function twoStep(conn: mysql.PoolConnection): Promise<number> {
    const [res] = await conn.query(`INSERT INTO \`${TABLE}\` (\`code\`) VALUES (?)`, [createTempOrderCode()]);
    const id = (res as mysql.ResultSetHeader).insertId;
    await conn.query(`UPDATE \`${TABLE}\` SET \`code\` = ? WHERE \`id\` = ?`, [deriveOrderCodeFromId(id), id]);
    return id;
  }

  it('happy: 임시코드가 확정 EPEVT 코드로 교체되고 TMP- 잔여 0', async () => {
    const conn = await pool.getConnection();
    let id: number;
    try {
      id = await twoStep(conn);
    } finally {
      conn.release();
    }
    const [rows] = await pool.query(`SELECT \`code\` FROM \`${TABLE}\` WHERE \`id\` = ?`, [id]);
    expect((rows as any[])[0].code).toBe(deriveOrderCodeFromId(id));
    expect((rows as any[])[0].code).toMatch(/^EPEVT\d{11}$/);

    const [agg] = await pool.query(`SELECT SUM(\`code\` LIKE 'TMP-%') temp FROM \`${TABLE}\``);
    expect(Number((agg as any[])[0].temp)).toBe(0);
  });

  it('rollback 시 임시코드 행이 커밋되지 않는다(F1 불변식)', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`INSERT INTO \`${TABLE}\` (\`code\`) VALUES (?)`, [createTempOrderCode()]);
      await conn.rollback();
    } finally {
      conn.release();
    }
    const [agg] = await pool.query(`SELECT COUNT(*) c FROM \`${TABLE}\``);
    expect(Number((agg as any[])[0].c)).toBe(0); // 임시코드가 남지 않음
  });

  it('동시 채번: 전부 고유 EPEVT 코드, 충돌 0, TMP- 잔여 0(F4)', async () => {
    const N = 30;
    const ids = await Promise.all(
      Array.from({ length: N }, async () => {
        const conn = await pool.getConnection();
        try {
          return await twoStep(conn);
        } finally {
          conn.release();
        }
      }),
    );

    const [agg] = await pool.query(
      `SELECT COUNT(*) total, COUNT(DISTINCT \`code\`) distinct_codes, SUM(\`code\` LIKE 'TMP-%') temp, SUM(\`code\` LIKE 'EPEVT%') epevt FROM \`${TABLE}\``,
    );
    const a = (agg as any[])[0];
    expect(Number(a.total)).toBe(N);
    expect(Number(a.distinct_codes)).toBe(N); // 전부 고유 → 충돌 0
    expect(Number(a.temp)).toBe(0); // 임시코드 잔여 0
    expect(Number(a.epevt)).toBe(N); // 전부 확정 EPEVT
    expect(new Set(ids).size).toBe(N); // id 도 전부 고유
  });
});
