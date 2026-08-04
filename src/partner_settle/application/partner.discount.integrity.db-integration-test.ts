import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { deleteDataSourceByName, initializeTransactionalContext } from 'typeorm-transactional';

import { PartnerDiscountHistoryEntity } from '../../entity/partner.discount.history.entity';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { PartnerDiscountIntegrityService } from './partner.discount.integrity.service';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';
import { buildScopeKey } from '../domain/discount.scope.key';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * 이력 무결성 검사와 정책 잠금 직렬화를 실DB로 검증한다.
 *
 * 검사기는 고치지 않고 알리기만 한다 — 깨진 이력을 조용히 보정하면 잘못된 매입율이 그대로 확정된다.
 */
describe('협력사 정산조건 무결성 · 잠금 직렬화', () => {
  let dataSource: DataSource;
  let service: PartnerDiscountIntegrityService;

  const scope = {
    partnerCompanyId: 1,
    category: IUserDiscountCategory.PRODUCT_GROUP,
    classificationId: null,
    method: IUserDiscountMethod.BULK,
    primaryCategory: null,
    group: '모바일쿠폰',
    range: null,
    compareCondition: ICompareCondition.ALL,
  };

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

    await dataSource.query(`
      ALTER TABLE \`partner_discount_history\`
        ADD COLUMN \`open_key\` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
          GENERATED ALWAYS AS (
            CASE WHEN \`valid_to\` IS NULL AND \`superseded_by_history_id\` IS NULL AND \`deleted_at\` IS NULL
                 THEN \`scope_key\` END
          ) STORED,
        ADD UNIQUE KEY \`uk_partner_discount_history_open\` (\`open_key\`)
    `);
    // partner_discount_scope 의 UNIQUE 는 엔티티에 선언돼 있어 synchronize 가 이미 만든다.

    service = new PartnerDiscountIntegrityService(
      dataSource.getRepository(PartnerDiscountHistoryEntity) as any,
      dataSource.getRepository(UserDiscountEntity) as any,
    );
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM `partner_discount_history`');
    await dataSource.query('DELETE FROM `partner_discount_scope`');
    await dataSource.query('DELETE FROM `user_discount`');
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function insertHistory(overrides: Record<string, unknown> = {}) {
    await dataSource.getRepository(PartnerDiscountHistoryEntity).insert({
      ...scope,
      scopeKey: buildScopeKey(scope),
      changeType: IPartnerDiscountChangeType.CREATE,
      pricePercent: 5,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      validFrom: new Date('2026-05-01T00:00:00.000'),
      validTo: null,
      changedBy: null,
      supersededByHistoryId: null,
      ...overrides,
    } as any);
  }

  it('정상 이력에는 위반이 없다', async () => {
    await insertHistory({ validTo: new Date('2026-06-01T00:00:00.000') });
    await insertHistory({
      changeType: IPartnerDiscountChangeType.DELETE,
      pricePercent: null,
      priceAdjustment: null,
      validFrom: new Date('2026-06-01T00:00:00.000'),
    });

    const report = await service.check();

    expect(report.violations).toEqual([]);
  });

  it('구간이 겹치면 잡아낸다', async () => {
    await insertHistory({ validTo: new Date('2026-07-01T00:00:00.000') });
    await insertHistory({
      validFrom: new Date('2026-06-01T00:00:00.000'),
      validTo: new Date('2026-08-01T00:00:00.000'),
    });

    const report = await service.check();

    expect(report.violations.map((violation) => violation.check)).toContain('OVERLAP');
  });

  it('마감 뒤를 잇는 구간이 없으면 hole 로 잡아낸다', async () => {
    await insertHistory({ validTo: new Date('2026-06-01T00:00:00.000') });
    await insertHistory({ validFrom: new Date('2026-07-01T00:00:00.000') });

    const report = await service.check();

    expect(report.violations.map((violation) => violation.check)).toContain('HOLE');
  });

  it('열린 구간이 하나도 없으면 잡아낸다', async () => {
    await insertHistory({ validTo: new Date('2026-06-01T00:00:00.000') });

    const report = await service.check();

    expect(report.violations.map((violation) => violation.check)).toEqual(
      expect.arrayContaining(['OPEN_INTERVAL_COUNT', 'HOLE']),
    );
  });

  it('이력 없는 활성 협력사 할인을 seed 누락으로 잡아낸다', async () => {
    // 원장은 이 상태를 "정당한 무매칭 0%" 로 처리하므로 런타임에 감지되지 않는다.
    await dataSource.getRepository(UserDiscountEntity).insert({
      ...scope,
      userId: null,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      pricePercent: 5,
    } as any);

    const report = await service.check();

    expect(report.violations.map((violation) => violation.check)).toContain('MISSING_SEED');
  });

  it('같은 대상에 할인과 할증이 동시에 활성이면 잡아낸다', async () => {
    const other = { ...scope, method: IUserDiscountMethod.SECTION, range: '10000' };

    await insertHistory();
    await dataSource.getRepository(PartnerDiscountHistoryEntity).insert({
      ...other,
      scopeKey: buildScopeKey(other),
      changeType: IPartnerDiscountChangeType.CREATE,
      pricePercent: 3,
      priceAdjustment: IPriceAdjustment.ADDITIONAL,
      validFrom: new Date('2026-05-01T00:00:00.000'),
      validTo: null,
      changedBy: null,
      supersededByHistoryId: null,
    } as any);

    const report = await service.check();

    expect(report.violations.map((violation) => violation.check)).toContain('CONFLICTING_ADJUSTMENT');
  });

  it('tombstone 구간은 방향 충돌 판정에서 제외한다', async () => {
    await insertHistory({
      changeType: IPartnerDiscountChangeType.DELETE,
      pricePercent: null,
      priceAdjustment: null,
    });

    const report = await service.check();

    expect(report.violations.map((violation) => violation.check)).not.toContain('CONFLICTING_ADJUSTMENT');
  });

  it('같은 scope 동시 생성은 앵커 락으로 직렬화되고 열린 구간은 하나만 남는다', async () => {
    const scopeKey = buildScopeKey(scope);

    const attempt = async () => {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query('INSERT IGNORE INTO `partner_discount_scope` (`scope_key`) VALUES (?)', [scopeKey]);
        await runner.query('SELECT id FROM `partner_discount_scope` WHERE `scope_key` = ? FOR UPDATE', [scopeKey]);
        await runner.query(
          `INSERT INTO partner_discount_history
             (partner_company_id, category, classification_id, method, primary_category, \`group\`, \`range\`,
              compare_condition, scope_key, change_type, price_percent, price_adjustment, valid_from, valid_to)
           VALUES (?, ?, NULL, ?, NULL, ?, NULL, ?, ?, 'CREATE', 5, 'DISCOUNT', '2026-05-01 00:00:00.000000', NULL)`,
          [scope.partnerCompanyId, scope.category, scope.method, scope.group, scope.compareCondition, scopeKey],
        );
        await runner.commitTransaction();
        return 'committed';
      } catch (error) {
        await runner.rollbackTransaction();
        return error;
      } finally {
        await runner.release();
      }
    };

    const results = await Promise.all([attempt(), attempt()]);

    expect(results.filter((result) => result === 'committed')).toHaveLength(1);

    const openRows = await dataSource.query(
      'SELECT COUNT(*) AS c FROM partner_discount_history WHERE scope_key = ? AND valid_to IS NULL',
      [scopeKey],
    );
    expect(Number(openRows[0].c)).toBe(1);
  });
});
