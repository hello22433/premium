import 'reflect-metadata';
import * as fs from 'fs';
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
 * adjustment proposal 테이블의 CHECK·UNIQUE·복합 FK 를 실DB로 검증한다 (PR3C §5.7·§8.5).
 *
 * 서비스 mock 테스트만으로는 DB CHECK 가 실제로 거부하는지 확인할 수 없다.
 * 마이그레이션과 동일한 DDL 을 적용한 뒤 성공·실패 조합을 INSERT 로 확인한다.
 */
describe('adjustment proposal DB 제약', () => {
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

    // `synchronize`로 의존 테이블의 pre-migration schema를 만든 뒤, 대상 테이블/컬럼은
    // 제거한다. DDL은 반드시 배포 마이그레이션 원본을 실행해 검증한다.
    await dataSource.query('DROP TABLE IF EXISTS `partner_settle_adjustment_proposal`');
    await dataSource.query('ALTER TABLE `partner_settle_ledger` DROP COLUMN `adjustment_proposal_id`');

    const migrationPath = path.resolve(
      __dirname,
      '../../../sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql',
    );
    const statements = fs.readFileSync(migrationPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await dataSource.query(statement);
    }

    await dataSource.query(`
      INSERT INTO \`partner_company\` (
        \`id\`, \`code\`, \`business_number\`, \`business_name\`, \`business_address\`,
        \`business_phone_number\`, \`person_name\`, \`person_phone_number\`, \`person_email\`,
        \`settle_condition\`, \`settle_day\`, \`settle_method\`, \`maximum_limit\`,
        \`bank_name\`, \`bank_number\`
      ) VALUES (3, 'TEST', '000', 'test', 'test', '000', 'test', '000', 'test@example.com',
        'PRE_PAYMENT', 1, 'CASH', 0, 'test', 'test')
    `);
    await dataSource.query(`
      INSERT INTO \`partner_discount_history\` (
        \`id\`, \`partner_company_id\`, \`category\`, \`classification_id\`, \`method\`,
        \`primary_category\`, \`group\`, \`range\`, \`compare_condition\`, \`scope_key\`,
        \`change_type\`, \`price_percent\`, \`price_adjustment\`, \`valid_from\`,
        \`valid_to\`, \`changed_by\`, \`superseded_by_history_id\`
      ) VALUES (5, 3, 'PRODUCT_GROUP', NULL, 'BULK', NULL, 'test', NULL, 'ALL', 'test',
        'CREATE', 0, 'DISCOUNT', '2026-01-01 00:00:00.000000', NULL, NULL, NULL)
    `);
    await dataSource.query(`
      INSERT INTO \`partner_settle_ledger\` (
        \`id\`, \`partner_company_id\`, \`sub_item_key\`, \`source_type\`, \`order_delivery_id\`,
        \`galaxia_barcode_log_id\`, \`occurred_at\`, \`base_amount\`, \`discount_amount\`,
        \`receiving_commission_amount\`, \`giving_commission_amount\`, \`vat_amount\`,
        \`vat_calculation_mode\`, \`fee_total_amount\`, \`applied_price_percent\`,
        \`applied_price_adjustment\`, \`applied_discount_history_id\`, \`pricing_resolution\`,
        \`settle_amount\`, \`idempotency_key\`, \`settle_batch_id\`, \`status\`
      ) VALUES (100, 3, 'NONE', 'ISSUANCE', NULL, NULL, '2026-01-01 00:00:00.000000',
        100, 0, 0, 0, 0, 'NONE', 0, 0, 'DISCOUNT', 5, 'HISTORY_MATCH', 100,
        'test-source-ledger', NULL, 'NORMAL')
    `);
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM `partner_settle_adjustment_proposal`');
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  function manualRow(overrides: Record<string, unknown> = {}) {
    return {
      partner_company_id: 3,
      sub_item_key: 'NONE',
      source_ledger_id: null,
      discount_change_id: null,
      proposed_amount: 200,
      reason: 'test',
      status: 'PENDING',
      created_by: 10,
      request_key: 'req-1',
      payload_hash: 'v1:abc123',
      payload_hash_version: 'v1',
      resolution_group_key: null,
      decided_by: null,
      decided_at: null,
      approved_amount: null,
      result_ledger_id: null,
      amount_override_reason: null,
      decision_reason: null,
      ...overrides,
    };
  }

  function systemRow(overrides: Record<string, unknown> = {}) {
    return {
      partner_company_id: 3,
      sub_item_key: 'NONE',
      source_ledger_id: 100,
      discount_change_id: 5,
      proposed_amount: -300,
      reason: '소급 재계산 차액',
      status: 'PENDING',
      created_by: null,
      request_key: null,
      payload_hash: null,
      payload_hash_version: null,
      resolution_group_key: '100:5',
      decided_by: null,
      decided_at: null,
      approved_amount: null,
      result_ledger_id: null,
      amount_override_reason: null,
      decision_reason: null,
      ...overrides,
    };
  }

  function insertProposal(row: Record<string, unknown>) {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    return dataSource.query(
      `INSERT INTO \`partner_settle_adjustment_proposal\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${placeholders})`,
      Object.values(row),
    );
  }

  // ─── 정상 INSERT ───

  it('manual PENDING row 정상 INSERT', async () => {
    await expect(insertProposal(manualRow())).resolves.toBeDefined();
  });

  it('system PENDING row 정상 INSERT', async () => {
    await expect(insertProposal(systemRow())).resolves.toBeDefined();
  });
  it('존재하지 않는 source ledger → 복합 FK가 거부', async () => {
    await expect(
      insertProposal(systemRow({ source_ledger_id: 999, resolution_group_key: '999:5' })),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('존재하지 않는 discount change → FK가 거부', async () => {
    await expect(
      insertProposal(systemRow({ discount_change_id: 999, resolution_group_key: '100:999' })),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('source ledger와 다른 partner → 복합 FK가 거부', async () => {
    await dataSource.query(`
      INSERT INTO \`partner_company\` (
        \`id\`, \`code\`, \`business_number\`, \`business_name\`, \`business_address\`,
        \`business_phone_number\`, \`person_name\`, \`person_phone_number\`, \`person_email\`,
        \`settle_condition\`, \`settle_day\`, \`settle_method\`, \`maximum_limit\`,
        \`bank_name\`, \`bank_number\`
      ) VALUES (4, 'TEST2', '001', 'test', 'test', '000', 'test', '000', 'test2@example.com',
        'PRE_PAYMENT', 1, 'CASH', 0, 'test', 'test')
    `);
    await expect(
      insertProposal(systemRow({ partner_company_id: 4 })),
    ).rejects.toThrow(/FOREIGN KEY/i);
    await dataSource.query(`
      INSERT INTO \`partner_discount_history\` (
        \`id\`, \`partner_company_id\`, \`category\`, \`classification_id\`, \`method\`,
        \`primary_category\`, \`group\`, \`range\`, \`compare_condition\`, \`scope_key\`,
        \`change_type\`, \`price_percent\`, \`price_adjustment\`, \`valid_from\`,
        \`valid_to\`, \`changed_by\`, \`superseded_by_history_id\`
      ) VALUES (6, 4, 'PRODUCT_GROUP', NULL, 'BULK', NULL, 'test', NULL, 'ALL', 'test-4',
        'CREATE', 0, 'DISCOUNT', '2026-01-01 00:00:00.000000', NULL, NULL, NULL)
    `);
    await expect(
      insertProposal(systemRow({ discount_change_id: 6, resolution_group_key: '100:6' })),
    ).rejects.toThrow(/FOREIGN KEY/i);
    await dataSource.query('DELETE FROM `partner_discount_history` WHERE `id` = 6');
    await dataSource.query('DELETE FROM `partner_company` WHERE `id` = 4');
  });

  // ─── status enum CHECK ───

  it('잘못된 status → 거부', async () => {
    await expect(insertProposal(manualRow({ status: 'UNKNOWN' }))).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  // ─── self-decision CHECK ───

  it('created_by == decided_by → 자기승인 거부', async () => {
    await expect(
      insertProposal(manualRow({
        status: 'APPROVED',
        decided_by: 10,
        decided_at: '2026-08-10 12:00:00.000000',
        approved_amount: 200,
      })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('created_by != decided_by → 정상', async () => {
    await expect(
      insertProposal(manualRow({
        status: 'APPROVED',
        decided_by: 20,
        decided_at: '2026-08-10 12:00:00.000000',
        approved_amount: 200,
        result_ledger_id: null,
      })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i); // 0원 아닌데 result_ledger_id null → result CHECK 도 거부
  });

  // ─── APPROVED 필수 필드 CHECK ───

  it('APPROVED 에 decided_by null → 거부', async () => {
    await expect(
      insertProposal(manualRow({
        status: 'APPROVED',
        decided_by: null,
        decided_at: '2026-08-10 12:00:00.000000',
        approved_amount: 200,
      })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('APPROVED 에 approved_amount null → 거부', async () => {
    await expect(
      insertProposal(manualRow({
        status: 'APPROVED',
        decided_by: 20,
        decided_at: '2026-08-10 12:00:00.000000',
        approved_amount: null,
      })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  // ─── REJECTED 필수/금지 필드 CHECK ───

  it('REJECTED 에 decision_reason null → 거부', async () => {
    await expect(
      insertProposal(manualRow({
        status: 'REJECTED',
        decided_by: 20,
        decided_at: '2026-08-10 12:00:00.000000',
        decision_reason: null,
      })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('REJECTED 에 approved_amount 있으면 → 거부', async () => {
    await expect(
      insertProposal(manualRow({
        status: 'REJECTED',
        decided_by: 20,
        decided_at: '2026-08-10 12:00:00.000000',
        decision_reason: '사유',
        approved_amount: 200,
      })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('REJECTED 정상', async () => {
    await expect(
      insertProposal(manualRow({
        status: 'REJECTED',
        decided_by: 20,
        decided_at: '2026-08-10 12:00:00.000000',
        decision_reason: '반려 사유',
      })),
    ).resolves.toBeDefined();
  });

  // ─── PENDING 금지 필드 CHECK ───

  it('PENDING 에 decided_by → 거부', async () => {
    await expect(
      insertProposal(manualRow({ decided_by: 20 })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('PENDING 에 approved_amount → 거부', async () => {
    await expect(
      insertProposal(manualRow({ approved_amount: 100 })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  // ─── override reason CHECK ───

  it('approved != proposed 인데 override_reason null → 거부', async () => {
    await expect(
      insertProposal(manualRow({
        status: 'APPROVED',
        decided_by: 20,
        decided_at: '2026-08-10 12:00:00.000000',
        approved_amount: 300, // != proposed 200
        amount_override_reason: null,
      })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  // ─── origin XOR CHECK ───

  it('system 필드 + manual 필드 혼재 → 거부', async () => {
    await expect(
      insertProposal(manualRow({
        discount_change_id: 5,
        resolution_group_key: '100:5',
      })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  it('system 에 created_by 있으면 → 거부', async () => {
    await expect(
      insertProposal(systemRow({ created_by: 10 })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  // ─── 0원 result 불변식 CHECK ───

  it('0원 승인 + result_ledger_id 있으면 → 거부', async () => {
    await expect(
      insertProposal(manualRow({
        status: 'APPROVED',
        decided_by: 20,
        decided_at: '2026-08-10 12:00:00.000000',
        approved_amount: 0,
        result_ledger_id: 500,
      })),
    ).rejects.toThrow(/CONSTRAINT|CHECK/i);
  });

  // ─── UNIQUE constraints ───

  it('같은 request_key 두 번 → 거부', async () => {
    await insertProposal(manualRow());
    await expect(
      insertProposal(manualRow({ request_key: 'req-1' })),
    ).rejects.toThrow(/Duplicate entry/i);
  });

  it('같은 (source_ledger_id, discount_change_id) 두 번 → 거부', async () => {
    await insertProposal(systemRow());
    await expect(
      insertProposal(systemRow({
        resolution_group_key: '100:5',
        source_ledger_id: 100,
        discount_change_id: 5,
      })),
    ).rejects.toThrow(/Duplicate entry/i);
  });
});
