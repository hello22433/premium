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
 * 단위 spec(order-code-derive, create-temp-order-code)은 실 phaseA/createTemp 를 구동하되
 * 트랜잭션이 stub이라 커밋/롤백/동시성을 검증하지 못한다. 본 통합테스트는 그 공백을
 * 실 MySQL에서 메꾼다:
 *   1) happy    : 임시코드(TMP-)가 확정 EPEVT 코드로 교체되고 TMP- 잔여 0
 *   2) rollback : 실 헬퍼로 2-step 을 돌린 뒤 롤백 → 임시코드/확정코드 모두 미커밋(F1)
 *   3) 동시성   : 동시 채번 시 전부 고유 EPEVT, 충돌·TMP- 잔여 0(F4)
 *   4) 대조(teeth): 동일 인터리빙에서 OLD read-max 는 결정적 충돌, 신규 2-step 은 무충돌
 *                  → 이 테스트가 "나쁜 채번"을 실제로 잡아냄을 증명(read-max 회귀 감지)
 *
 * 범위: order.code 채번 메커니즘 + 실 헬퍼(createTempOrderCode/deriveOrderCodeFromId)를
 * auto_increment PK + UNIQUE(code) 전용 테이블에서 검증(order FK 그래프 배제).
 * save() 기반 외부 사이트의 엔티티 재저장 의미론은 단위 spec(order-code-derive)이 실 phaseA 구동으로 커버.
 * DATABASE_DATABASE 이름에 test 없으면 skip(기존 *.db-integration-test 규약과 동일).
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

  // 신규 2-step(createTemp 의 insert 기반과 동일) — 실 프로덕션 헬퍼 사용
  async function twoStep(conn: mysql.PoolConnection): Promise<number> {
    const [res] = await conn.query(`INSERT INTO \`${TABLE}\` (\`code\`) VALUES (?)`, [createTempOrderCode()]);
    const id = (res as mysql.ResultSetHeader).insertId;
    await conn.query(`UPDATE \`${TABLE}\` SET \`code\` = ? WHERE \`id\` = ?`, [deriveOrderCodeFromId(id), id]);
    return id;
  }

  // 폐기된 OLD 채번(최신 code 읽고 +1) — 대조군(프로덕션 아님, 회귀 감지력 증명용)
  function nextReadMaxCode(prevCode: string | null): string {
    const next = prevCode ? Number(prevCode.slice(5)) + 1 : 1;
    return 'EPEVT' + String(next).padStart(11, '0');
  }
  async function readMax(conn: mysql.PoolConnection): Promise<string | null> {
    const [rows] = await conn.query(
      `SELECT \`code\` FROM \`${TABLE}\` WHERE \`code\` LIKE 'EPEVT%' ORDER BY \`code\` DESC LIMIT 1`,
    );
    return (rows as any[]).length ? (rows as any[])[0].code : null;
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

  it('rollback: 2-step 을 돌린 뒤 롤백하면 임시·확정 코드 모두 미커밋(F1 불변식)', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await twoStep(conn); // 실 헬퍼로 insert(TMP-) + update(EPEVT) 수행
      await conn.rollback();
    } finally {
      conn.release();
    }
    // 임시코드도 확정코드도 커밋되지 않아야 함
    const [agg] = await pool.query(
      `SELECT COUNT(*) total, SUM(\`code\` LIKE 'TMP-%') temp, SUM(\`code\` LIKE 'EPEVT%') epevt FROM \`${TABLE}\``,
    );
    const a = (agg as any[])[0];
    expect(Number(a.total)).toBe(0);
    expect(Number(a.temp)).toBe(0);
    expect(Number(a.epevt)).toBe(0);
  });

  it('동시 채번: 동시 30건 전부 고유 EPEVT, 충돌 0, TMP- 잔여 0(F4)', async () => {
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
    expect(Number(a.distinct_codes)).toBe(N);
    expect(Number(a.temp)).toBe(0);
    expect(Number(a.epevt)).toBe(N);
    expect(new Set(ids).size).toBe(N);
  });

  it('대조(teeth): 동일 인터리빙에서 OLD read-max 는 결정적으로 충돌한다', async () => {
    await pool.query(`INSERT INTO \`${TABLE}\` (\`code\`) VALUES ('EPEVT00000000001')`); // 시드
    const c1 = await pool.getConnection();
    const c2 = await pool.getConnection();
    try {
      // 두 요청이 커밋 전 같은 max(001)을 읽음 → 둘 다 002 계산
      const prev1 = await readMax(c1);
      const prev2 = await readMax(c2);
      const code1 = nextReadMaxCode(prev1);
      const code2 = nextReadMaxCode(prev2);
      expect(code1).toBe(code2); // 같은 값을 채번 = race

      await c1.query(`INSERT INTO \`${TABLE}\` (\`code\`) VALUES (?)`, [code1]);
      // 두 번째 INSERT 는 UNIQUE 위반으로 결정적 실패 → 이 테스트가 나쁜 채번을 잡아냄을 증명
      await expect(c2.query(`INSERT INTO \`${TABLE}\` (\`code\`) VALUES (?)`, [code2])).rejects.toThrow(
        /ER_DUP_ENTRY|Duplicate/,
      );
    } finally {
      c1.release();
      c2.release();
    }
  });

  it('대조(teeth): 동일 인터리빙에서 신규 2-step 은 충돌하지 않는다', async () => {
    const c1 = await pool.getConnection();
    const c2 = await pool.getConnection();
    try {
      // 둘 다 임시코드로 먼저 insert → auto_increment 가 서로 다른 id 부여
      const [r1] = await c1.query(`INSERT INTO \`${TABLE}\` (\`code\`) VALUES (?)`, [createTempOrderCode()]);
      const [r2] = await c2.query(`INSERT INTO \`${TABLE}\` (\`code\`) VALUES (?)`, [createTempOrderCode()]);
      const id1 = (r1 as mysql.ResultSetHeader).insertId;
      const id2 = (r2 as mysql.ResultSetHeader).insertId;
      expect(id1).not.toBe(id2); // id 가 다르므로 파생 code 도 다름

      // 각자 자기 id 파생 코드로 update → 충돌 없이 둘 다 성공
      await c1.query(`UPDATE \`${TABLE}\` SET \`code\` = ? WHERE \`id\` = ?`, [deriveOrderCodeFromId(id1), id1]);
      await c2.query(`UPDATE \`${TABLE}\` SET \`code\` = ? WHERE \`id\` = ?`, [deriveOrderCodeFromId(id2), id2]);
    } finally {
      c1.release();
      c2.release();
    }
    const [agg] = await pool.query(
      `SELECT COUNT(*) total, COUNT(DISTINCT \`code\`) distinct_codes, SUM(\`code\` LIKE 'TMP-%') temp FROM \`${TABLE}\``,
    );
    const a = (agg as any[])[0];
    expect(Number(a.total)).toBe(2);
    expect(Number(a.distinct_codes)).toBe(2); // 충돌 없음
    expect(Number(a.temp)).toBe(0);
  });
});
