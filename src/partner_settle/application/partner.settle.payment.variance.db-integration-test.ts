import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { deleteDataSourceByName, initializeTransactionalContext } from 'typeorm-transactional';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * 지급 차이 provenance 의 DB 불변식을 실DB로 검증한다 (정본 §5 220행 · §5.7.2 · PR3A).
 *
 * 서비스 검증만으로는 부족하다 — `PAYMENT_VARIANCE` sentinel 이 일반 원장에 섞이면 여신 표의
 * 하위항목 합계와 확정 sweep 이 동시에 오염되고, 그 row 는 사후에 구별할 방법이 없다.
 * 그래서 형태를 DB CHECK·UNIQUE·복합 FK 로 못 박고, 여기서 실제로 거부되는지 확인한다.
 *
 * `synchronize` 는 엔티티에 없는 CHECK·복합 UNIQUE 를 만들지 않으므로 마이그레이션과 같은 DDL 을
 * 여기서 직접 적용한다(`20260807_partner_settle_pr3a_variance.sql` 과 같은 내용).
 */
describe('PAYMENT_VARIANCE provenance DB 제약', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    initializeTransactionalContext();
    deleteDataSourceByName('default');

    const database = process.env.DATABASE_DATABASE;
    if (!database || !TEST_DB_NAME_PATTERN.test(database)) {
      throw new Error('DB 통합테스트는 이름에 test가 포함된 DATABASE_DATABASE에서만 실행할 수 있습니다.');
    }

    const connection = await mysql.createConnection({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      multipleStatements: false,
    });
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await connection.end();

    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database,
      entities: [path.join(process.cwd(), 'src/**/*.entity.ts')],
      namingStrategy: new SnakeNamingStrategy(),
      timezone: '+09:00',
      synchronize: true,
      dropSchema: true,
      logging: false,
      extra: { connectionLimit: 5 },
    });

    await dataSource.initialize();

    // 원장 형태 CHECK — 마이그레이션 §1 과 동일.
    await dataSource.query(`
      ALTER TABLE \`partner_settle_ledger\`
        ADD UNIQUE KEY \`uk_partner_settle_ledger_payment_variance\` (\`payment_variance_proposal_id\`),
        ADD UNIQUE KEY \`uk_partner_settle_ledger_variance_provenance\`
          (\`id\`, \`payment_variance_proposal_id\`, \`partner_company_id\`),
        ADD CONSTRAINT \`chk_partner_settle_ledger_variance_shape\` CHECK (
          \`payment_variance_proposal_id\` IS NULL OR (
            \`source_type\` = 'ADJUSTMENT'
            AND \`sub_item_key\` = 'PAYMENT_VARIANCE'
            AND \`idempotency_key\` = CONCAT('PAYMENT_VARIANCE:', \`payment_variance_proposal_id\`)
            AND \`settle_batch_id\` IS NULL
            AND \`status\` = 'NORMAL'
            AND \`pricing_resolution\` = 'DIRECT_AMOUNT'
            AND \`base_amount\` = \`settle_amount\`
            AND \`occurred_at\` IS NOT NULL
          )
        ),
        ADD CONSTRAINT \`chk_partner_settle_ledger_variance_sentinel\` CHECK (
          \`sub_item_key\` <> 'PAYMENT_VARIANCE' OR \`payment_variance_proposal_id\` IS NOT NULL
        )
    `);
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM `partner_settle_ledger`');
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  /** 승인 서비스가 만드는 것과 같은 형태의 variance ADJUSTMENT. */
  function varianceRow(overrides: Record<string, unknown> = {}) {
    return {
      partner_company_id: 3,
      sub_item_key: 'PAYMENT_VARIANCE',
      source_type: 'ADJUSTMENT',
      order_delivery_id: null,
      occurred_at: '2026-08-07 13:24:35.123456',
      base_amount: 2000,
      discount_amount: 0,
      receiving_commission_amount: 0,
      giving_commission_amount: 0,
      vat_amount: 0,
      vat_calculation_mode: 'NONE',
      fee_total_amount: 0,
      applied_price_percent: 0,
      applied_price_adjustment: 'DISCOUNT',
      applied_discount_history_id: null,
      pricing_resolution: 'DIRECT_AMOUNT',
      settle_amount: 2000,
      idempotency_key: 'PAYMENT_VARIANCE:7',
      settle_batch_id: null,
      status: 'NORMAL',
      payment_variance_proposal_id: 7,
      ...overrides,
    };
  }

  function insertLedger(row: Record<string, unknown>) {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    return dataSource.query(
      `INSERT INTO \`partner_settle_ledger\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${placeholders})`,
      Object.values(row),
    );
  }

  it('정상 형태는 INSERT 된다', async () => {
    await expect(insertLedger(varianceRow())).resolves.toBeDefined();
  });

  it('음수 조정(과지급)도 INSERT 된다', async () => {
    await expect(insertLedger(varianceRow({ base_amount: -3000, settle_amount: -3000 }))).resolves.toBeDefined();
  });

  it('proposal 당 원장 1건 — 같은 proposalId 두 번째는 거부', async () => {
    await insertLedger(varianceRow());
    await expect(
      insertLedger(varianceRow({ idempotency_key: 'PAYMENT_VARIANCE:7-dup' })),
    ).rejects.toThrow(/Duplicate entry/i);
  });

  it('멱등키 형식이 다르면 거부 (PAYMENT_VARIANCE:{proposalId} 강제)', async () => {
    await expect(insertLedger(varianceRow({ idempotency_key: 'MANUAL:7' }))).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('확정 batch 에 미리 편입된 채로는 거부 (settle_batch_id 는 NULL)', async () => {
    await expect(insertLedger(varianceRow({ settle_batch_id: 1 }))).rejects.toThrow(/CONSTRAINT|CHECK|foreign key/i);
  });

  it('occurred_at 없이는 거부 (귀속 시각 필수)', async () => {
    await expect(insertLedger(varianceRow({ occurred_at: null }))).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('base != settle 이면 거부 (조정은 구성금액을 만들지 않는다)', async () => {
    await expect(insertLedger(varianceRow({ settle_amount: 1500 }))).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('ADJUSTMENT 가 아니면 거부', async () => {
    await expect(
      insertLedger(varianceRow({ source_type: 'USAGE', order_delivery_id: 1, pricing_resolution: 'HISTORY_MATCH' })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('일반 원장이 PAYMENT_VARIANCE sentinel 을 쓰면 거부 (역방향 CHECK)', async () => {
    await expect(
      insertLedger(
        varianceRow({
          payment_variance_proposal_id: null,
          idempotency_key: 'MANUAL_LEDGER:1',
        }),
      ),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('proposal 이 있는데 하위항목이 sentinel 이 아니면 거부', async () => {
    await expect(insertLedger(varianceRow({ sub_item_key: 'NONE' }))).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });
});
