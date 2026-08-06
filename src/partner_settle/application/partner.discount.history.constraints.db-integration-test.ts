import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource, Repository } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { deleteDataSourceByName, initializeTransactionalContext } from 'typeorm-transactional';

import { PartnerDiscountHistoryEntity } from '../../entity/partner.discount.history.entity';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * 정산조건 이력의 DB 불변식을 실DB로 검증한다.
 *
 * 서비스 락만으로는 부족하다 — 이력은 `settleAmount` 의 근거 테이블이라 수동 DB 조작·경합에도
 * 깨지지 않아야 한다. 그래서 open 구간 1개·값 정합·구간 방향·할인율 상한을 DB 제약으로 강제하고,
 * 여기서 그 제약이 실제로 걸리는지 확인한다.
 *
 * `synchronize` 는 엔티티에 없는 generated 컬럼·CHECK 를 만들지 않으므로,
 * 마이그레이션과 같은 DDL 을 여기서 직접 적용한 뒤 검증한다.
 */
describe('partner_discount_history DB 제약', () => {
  let dataSource: DataSource;
  let historyRepository: Repository<PartnerDiscountHistoryEntity>;

  const baseScope = {
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
        ADD UNIQUE KEY \`uk_partner_discount_history_open\` (\`open_key\`),
        ADD CONSTRAINT \`chk_partner_discount_history_value\`
          CHECK (
            (\`change_type\` = 'DELETE' AND \`price_percent\` IS NULL AND \`price_adjustment\` IS NULL)
            OR (\`change_type\` <> 'DELETE' AND \`price_percent\` IS NOT NULL AND \`price_adjustment\` IS NOT NULL)
          ),
        ADD CONSTRAINT \`chk_partner_discount_history_interval\`
          CHECK (\`valid_to\` IS NULL OR \`valid_from\` < \`valid_to\`),
        ADD CONSTRAINT \`chk_partner_discount_history_percent\`
          CHECK (
            \`price_adjustment\` IS NULL
            OR (\`price_adjustment\` = 'DISCOUNT'   AND \`price_percent\` BETWEEN 0 AND 100)
            OR (\`price_adjustment\` = 'ADDITIONAL' AND \`price_percent\` BETWEEN 0 AND 1000)
          )
    `);

    historyRepository = dataSource.getRepository(PartnerDiscountHistoryEntity);
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM `partner_discount_history`');
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  function createRow(scopeKey: string, overrides: Partial<PartnerDiscountHistoryEntity> = {}) {
    return historyRepository.insert({
      ...baseScope,
      scopeKey,
      changeType: IPartnerDiscountChangeType.CREATE,
      pricePercent: 5,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      validFrom: new Date('2026-05-01T00:00:00.000'),
      validTo: null,
      changedBy: null,
      supersededByHistoryId: null,
      ...overrides,
    });
  }

  it('같은 scope 에 열린 구간이 2개 생기지 않는다', async () => {
    await createRow('sk1|dup');

    await expect(createRow('sk1|dup')).rejects.toThrow(/Duplicate entry/i);
  });

  it('열린 구간을 마감하면 같은 scope 에 새 구간을 열 수 있다', async () => {
    const inserted = await createRow('sk1|reopen');

    await historyRepository.update(inserted.identifiers[0].id, { validTo: new Date('2026-06-01T00:00:00.000') });

    await expect(
      createRow('sk1|reopen', {
        changeType: IPartnerDiscountChangeType.DELETE,
        pricePercent: null,
        priceAdjustment: null,
        validFrom: new Date('2026-06-01T00:00:00.000'),
      }),
    ).resolves.toBeDefined();
  });

  it('superseded 처리된 구간은 열린 구간 자리를 점유하지 않는다', async () => {
    const inserted = await createRow('sk1|superseded');
    await historyRepository.update(inserted.identifiers[0].id, { supersededByHistoryId: inserted.identifiers[0].id });

    await expect(createRow('sk1|superseded')).resolves.toBeDefined();
  });

  it('soft-delete 된 구간도 열린 구간 자리를 점유하지 않는다', async () => {
    const inserted = await createRow('sk1|softdeleted');
    await historyRepository.softDelete(inserted.identifiers[0].id);

    await expect(createRow('sk1|softdeleted')).resolves.toBeDefined();
  });

  it('tombstone 이 아닌데 값이 비면 거부한다', async () => {
    await expect(
      createRow('sk1|novalue', { pricePercent: null, priceAdjustment: null }),
    ).rejects.toThrow(/chk_partner_discount_history_value/i);
  });

  it('tombstone 에 값이 있으면 거부한다', async () => {
    await expect(
      createRow('sk1|tombvalue', { changeType: IPartnerDiscountChangeType.DELETE }),
    ).rejects.toThrow(/chk_partner_discount_history_value/i);
  });

  it('종료가 시작보다 빠르거나 같으면 거부한다', async () => {
    await expect(
      createRow('sk1|reversed', {
        validFrom: new Date('2026-06-01T00:00:00.000'),
        validTo: new Date('2026-05-01T00:00:00.000'),
      }),
    ).rejects.toThrow(/chk_partner_discount_history_interval/i);

    await expect(
      createRow('sk1|zerolength', {
        validFrom: new Date('2026-06-01T00:00:00.000'),
        validTo: new Date('2026-06-01T00:00:00.000'),
      }),
    ).rejects.toThrow(/chk_partner_discount_history_interval/i);
  });

  it('할인 100% 초과는 거부한다 (음수 공급가 방지)', async () => {
    await expect(createRow('sk1|over100', { pricePercent: 101 })).rejects.toThrow(
      /chk_partner_discount_history_percent/i,
    );
  });

  it('할증 상한은 1000% 이고 그 이하는 허용한다', async () => {
    await expect(
      createRow('sk1|add1000', { pricePercent: 1000, priceAdjustment: IPriceAdjustment.ADDITIONAL }),
    ).resolves.toBeDefined();

    await expect(
      createRow('sk1|add1001', { pricePercent: 1001, priceAdjustment: IPriceAdjustment.ADDITIONAL }),
    ).rejects.toThrow(/chk_partner_discount_history_percent/i);
  });

  it('음수 할인율은 거부한다', async () => {
    await expect(createRow('sk1|negative', { pricePercent: -1 })).rejects.toThrow(
      /chk_partner_discount_history_percent/i,
    );
  });
});
