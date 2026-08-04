import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { classifySsgIssueLogCollision } from './ssg-insert-state.service';

dotenv.config();

jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;
const database = process.env.DATABASE_DATABASE;
const describeDb = database && TEST_DB_NAME_PATTERN.test(database) ? describe : describe.skip;

/**
 * ssg_issue_log 후보 유일성 제약의 실 엔진 검증.
 *
 * 단위 spec 은 driver 오류를 손으로 흉내내므로 "엔진이 실제로 어떤 sqlMessage 를 만드는가" 를
 * 증명하지 못한다. 분류가 빗나가면 충돌이 일반 실패로 뭉개지거나 기존 PIN 복구 분기로
 * 오진입해 다른 고객의 PIN 이 발송 건에 부착될 수 있으므로, 그 가정만은 실 엔진으로 검증한다.
 *
 *   1) 인덱스명 포맷  : 실제 위반 오류를 classifySsgIssueLogCollision 이 올바른 키로 분류
 *   2) 동시 INSERT    : 같은 bar_code 로 경쟁 INSERT 시 정확히 1건만 커밋
 *   3) 무관 unique    : 다른 인덱스 위반은 null (원본 전파 대상)
 *
 * 실 ssg_issue_log 를 건드리지 않기 위해 동일 인덱스명을 가진 전용 테이블에서 수행한다.
 * (MySQL 의 인덱스명은 테이블 스코프라 이름 재사용이 가능하다. 분류기가 테이블 prefix 유무를
 *  모두 수용하는지도 이 경로에서 함께 확인된다.)
 *
 * DATABASE_DATABASE 이름에 test 없으면 skip (기존 *.db-integration-test 규약과 동일).
 */
describeDb('ssg_issue_log 후보 유일성 제약 DB integration', () => {
  const TABLE = 'ssg_issue_log_unique_it';
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
      `CREATE TABLE \`${TABLE}\` (
         \`id\` INT NOT NULL AUTO_INCREMENT,
         \`bar_code\` VARCHAR(32) NOT NULL,
         \`personal_code\` VARCHAR(32) NOT NULL,
         \`order_delivery_id\` INT NOT NULL,
         \`other_code\` VARCHAR(32) NOT NULL,
         PRIMARY KEY(\`id\`),
         UNIQUE KEY \`uq_ssg_issue_log_bar_code\`(\`bar_code\`),
         UNIQUE KEY \`uq_ssg_issue_log_personal_code\`(\`personal_code\`),
         UNIQUE KEY \`uq_some_other_index\`(\`other_code\`)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
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

  const insertRow = (row: { barCode: string; personalCode: string; orderDeliveryId: number; otherCode: string }) =>
    pool.query(
      `INSERT INTO \`${TABLE}\` (bar_code, personal_code, order_delivery_id, other_code) VALUES (?, ?, ?, ?)`,
      [row.barCode, row.personalCode, row.orderDeliveryId, row.otherCode],
    );

  const captureError = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    throw new Error('중복 INSERT 가 실패하지 않았다 (UNIQUE 제약 미적용)');
  };

  it('bar_code 위반을 실 엔진 오류에서 bar_code 로 분류한다', async () => {
    await insertRow({ barCode: '80000001', personalCode: '01311111111', orderDeliveryId: 1, otherCode: 'o1' });

    const error = await captureError(() =>
      insertRow({ barCode: '80000001', personalCode: '01322222222', orderDeliveryId: 2, otherCode: 'o2' }),
    );

    expect(classifySsgIssueLogCollision(error)).toBe('bar_code');
  });

  it('personal_code 위반을 실 엔진 오류에서 personal_code 로 분류한다', async () => {
    await insertRow({ barCode: '80000001', personalCode: '01311111111', orderDeliveryId: 1, otherCode: 'o1' });

    const error = await captureError(() =>
      insertRow({ barCode: '80000002', personalCode: '01311111111', orderDeliveryId: 2, otherCode: 'o2' }),
    );

    expect(classifySsgIssueLogCollision(error)).toBe('personal_code');
  });

  it('무관한 unique 인덱스 위반은 분류하지 않는다 (원본 전파 대상)', async () => {
    await insertRow({ barCode: '80000001', personalCode: '01311111111', orderDeliveryId: 1, otherCode: 'same' });

    const error = await captureError(() =>
      insertRow({ barCode: '80000002', personalCode: '01322222222', orderDeliveryId: 2, otherCode: 'same' }),
    );

    expect(classifySsgIssueLogCollision(error)).toBeNull();
  });

  it('같은 bar_code 로 동시 INSERT 하면 정확히 1건만 커밋된다', async () => {
    const concurrency = 8;

    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, (_, i) =>
        insertRow({
          barCode: '80000009',
          personalCode: `013000000${i}`,
          orderDeliveryId: 100 + i,
          otherCode: `oc-${i}`,
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(concurrency - 1);
    // 실패는 전부 후보 충돌로 분류되어야 한다 (다른 오류가 섞이면 재시도 대신 전파되어야 하므로).
    rejected.forEach((r) => {
      expect(classifySsgIssueLogCollision(r.reason)).toBe('bar_code');
    });

    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM \`${TABLE}\` WHERE bar_code = '80000009'`,
    );
    expect(Number(rows[0].c)).toBe(1);
  });
});
