import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource, Repository } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { deleteDataSourceByName, initializeTransactionalContext } from 'typeorm-transactional';

import { PartnerDiscountReservationEntity } from '../../entity/partner.discount.reservation.entity';
import {
  IPartnerDiscountReservationFailureCode,
  IPartnerDiscountReservationStatus,
} from '../interface/partner.discount.reservation.status';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * 정산조건 예약의 DB 불변식을 실DB로 검증한다.
 *
 * 중복 예약 차단은 앱 레벨 선검사가 아니라 DB unique 여야 한다 — 동시 생성 2건 중 1건만 성공해야
 * 하기 때문이다. `active_key` 가 PENDING 에만 값을 갖는 것도 여기서 확인한다: BLOCKED 가 슬롯을
 * 계속 물고 있으면 취소 후 재예약이라는 유일한 해제 경로가 막힌다.
 *
 * `synchronize` 는 엔티티에 없는 generated 컬럼·CHECK 를 만들지 않으므로 마이그레이션과 같은 DDL 을
 * 여기서 직접 적용한 뒤 검증한다.
 */
describe('partner_discount_reservation DB 제약', () => {
  let dataSource: DataSource;
  let reservationRepository: Repository<PartnerDiscountReservationEntity>;

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
      ALTER TABLE \`partner_discount_reservation\`
        ADD COLUMN \`active_key\` TINYINT(1)
          GENERATED ALWAYS AS (CASE WHEN \`status\` = 'PENDING' THEN 1 END) STORED,
        ADD UNIQUE KEY \`uk_partner_discount_reservation_active\` (\`scope_key\`, \`effective_at\`, \`active_key\`),
        ADD UNIQUE KEY \`uk_partner_discount_reservation_request\` (\`request_key\`),
        ADD CONSTRAINT \`chk_partner_discount_reservation_percent\`
          CHECK (
            (\`price_adjustment\` = 'DISCOUNT'   AND \`price_percent\` BETWEEN 0 AND 100)
            OR (\`price_adjustment\` = 'ADDITIONAL' AND \`price_percent\` BETWEEN 0 AND 1000)
          ),
        ADD CONSTRAINT \`chk_partner_discount_reservation_status\`
          CHECK (\`status\` IN ('PENDING', 'APPLIED', 'CANCELED', 'BLOCKED')),
        ADD CONSTRAINT \`chk_partner_discount_reservation_failure_code\`
          CHECK (
            \`last_failure_code\` IS NULL
            OR \`last_failure_code\` IN ('POLICY_CONFLICT', 'INTERVAL_INVARIANT', 'RETROACTIVE_DISABLED')
          ),
        ADD CONSTRAINT \`chk_partner_discount_reservation_result\`
          CHECK (
            (\`status\` = 'APPLIED' AND \`result_history_id\` IS NOT NULL)
            OR (\`status\` <> 'APPLIED' AND \`result_history_id\` IS NULL)
          )
    `);

    reservationRepository = dataSource.getRepository(PartnerDiscountReservationEntity);
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM `partner_discount_reservation`');
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const EFFECTIVE_AT = new Date('2026-09-01T05:00:00.000');

  function createRow(overrides: Partial<PartnerDiscountReservationEntity> = {}) {
    return reservationRepository.insert({
      ...baseScope,
      scopeKey: 'sk1|1|PRODUCT_GROUP|-|BULK|-|모바일쿠폰|-|ALL',
      pricePercent: 10,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      effectiveAt: EFFECTIVE_AT,
      status: IPartnerDiscountReservationStatus.PENDING,
      registeredBy: 1,
      resultHistoryId: null,
      requestKey: `req-${Math.random().toString(36).slice(2)}`,
      payloadHash: 'v1:hash',
      payloadHashVersion: 'v1',
      isRetroactive: false,
      lastFailureCode: null,
      lastFailureAt: null,
      ...overrides,
    });
  }

  it('같은 scope·같은 시각의 PENDING 은 1건만 남는다', async () => {
    await createRow();

    await expect(createRow()).rejects.toThrow(/Duplicate entry/i);
  });

  it('같은 requestKey 는 두 번 들어가지 않는다', async () => {
    await createRow({ requestKey: 'req-fixed' });

    await expect(createRow({ requestKey: 'req-fixed', effectiveAt: new Date('2026-10-01T05:00:00.000') })).rejects.toThrow(
      /Duplicate entry/i,
    );
  });

  it('CANCELED 로 해소되면 같은 (scope, 시각) 재예약이 허용된다', async () => {
    const first = await createRow();
    await reservationRepository.update(first.identifiers[0].id as number, {
      status: IPartnerDiscountReservationStatus.CANCELED,
    });

    await expect(createRow()).resolves.toBeDefined();
  });

  it('BLOCKED 도 슬롯을 물지 않는다 — 취소 후 재예약이 유일한 해제 경로이기 때문', async () => {
    const first = await createRow();
    await reservationRepository.update(first.identifiers[0].id as number, {
      status: IPartnerDiscountReservationStatus.BLOCKED,
    });

    await expect(createRow()).resolves.toBeDefined();
  });

  it('DISCOUNT 100 초과는 거부된다 — 음수 공급가 방지', async () => {
    await expect(createRow({ pricePercent: 101 })).rejects.toThrow(/check constraint/i);
  });

  it('ADDITIONAL 1000 초과는 거부된다', async () => {
    await expect(
      createRow({ pricePercent: 1001, priceAdjustment: IPriceAdjustment.ADDITIONAL }),
    ).rejects.toThrow(/check constraint/i);
  });

  it('APPLIED 가 아닌 상태에 발효 결과가 붙지 않는다', async () => {
    await expect(createRow({ resultHistoryId: 1 })).rejects.toThrow(/check constraint/i);
  });

  it('알 수 없는 status 는 거부된다 — active_key·due 조회에서 동시에 빠지는 값이라 조용히 사라진다', async () => {
    await expect(
      createRow({ status: 'GARBAGE' as IPartnerDiscountReservationStatus }),
    ).rejects.toThrow(/check constraint/i);
  });

  it('알 수 없는 실패 사유 코드는 거부된다', async () => {
    await expect(
      createRow({ lastFailureCode: 'WHATEVER' as IPartnerDiscountReservationFailureCode }),
    ).rejects.toThrow(/check constraint/i);
  });
});
