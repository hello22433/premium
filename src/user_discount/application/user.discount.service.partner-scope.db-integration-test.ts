import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource, IsNull, Repository } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { PartnerDiscountHistoryEntity } from '../../entity/partner.discount.history.entity';
import { PartnerDiscountScopeEntity } from '../../entity/partner.discount.scope.entity';
import { PartnerDiscountPolicyEpochEntity } from '../../entity/partner.discount.policy.epoch.entity';
import { UserEntity } from '../../entity/user.entity';
import { ClassificationEntity } from '../../entity/classification.entity';
import { UserDiscountService } from './user.discount.service';
import { PartnerDiscountHistoryService } from '../../partner_settle/application/partner.discount.history.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserDiscountCategory } from '../interface/user.discount.category';
import { IUserDiscountMethod } from '../interface/user.discount.method';
import { ICompareCondition } from '../interface/compare.condition';
import { IPriceAdjustment } from '../interface/price.adjustment';

dotenv.config();
jest.setTimeout(180_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * 협력사 정산조건 쓰기 경로를 **실DB 트랜잭션**으로 검증한다.
 *
 * 단위 테스트는 `@Transactional` 을 mock 으로 무력화하므로 "한 트랜잭션" 이라는 계약 자체를 확인할 수 없다.
 * 여기서 검증하는 두 가지가 무너지면 조용히 틀린 매입율이 만들어진다.
 *  ① 원자성 — 원본만 남고 이력이 없으면 원장이 그 할인을 0% 로 계산한다.
 *  ② 정책 잠금 직렬화 — 같은 대상에 일괄·구간 할인이 동시에 살아남으면 matcher 가 충돌로 이벤트를 격리한다.
 */
describe('UserDiscountService 협력사 정산조건 — 트랜잭션·잠금 (실DB)', () => {
  let dataSource: DataSource;
  let service: UserDiscountService;
  let historyService: PartnerDiscountHistoryService;
  let userDiscountRepository: Repository<UserDiscountEntity>;
  let historyRepository: Repository<PartnerDiscountHistoryEntity>;
  let epochRepository: Repository<PartnerDiscountPolicyEpochEntity>;

  const PARTNER_COMPANY_ID = 1;
  const GROUP = '모바일쿠폰';
  const loginUser = { id: 1, email: 'admin@example.com', authority: IUserAuthority.OPERATION_ADMIN } as any;

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
      // 동시 요청 2건 + 잠금 대기를 표현하려면 커넥션이 여러 개 필요하다.
      extra: { connectionLimit: 5 },
    });

    await dataSource.initialize();
    addTransactionalDataSource(dataSource);

    // 마이그레이션이 만드는 open 구간 UNIQUE 는 generated 컬럼이라 엔티티로 표현할 수 없다.
    await dataSource.query(`
      ALTER TABLE \`partner_discount_history\`
        ADD COLUMN \`open_key\` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
          GENERATED ALWAYS AS (
            CASE WHEN \`valid_to\` IS NULL AND \`superseded_by_history_id\` IS NULL AND \`deleted_at\` IS NULL
                 THEN \`scope_key\` END
          ) STORED,
        ADD UNIQUE KEY \`uk_partner_discount_history_open\` (\`open_key\`)
    `);

    userDiscountRepository = dataSource.getRepository(UserDiscountEntity);
    historyRepository = dataSource.getRepository(PartnerDiscountHistoryEntity);
    epochRepository = dataSource.getRepository(PartnerDiscountPolicyEpochEntity);

    historyService = new PartnerDiscountHistoryService(
      historyRepository,
      dataSource.getRepository(PartnerDiscountScopeEntity),
      epochRepository,
    );
    service = new UserDiscountService(
      userDiscountRepository,
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(ClassificationEntity),
      historyService,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await dataSource.query('DELETE FROM `partner_discount_history`');
    await dataSource.query('DELETE FROM `partner_discount_scope`');
    await dataSource.query('DELETE FROM `partner_discount_policy_epoch`');
    await dataSource.query('DELETE FROM `user_discount`');
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  function bulkBody(overrides: Record<string, unknown> = {}) {
    return {
      partnerCompanyId: PARTNER_COMPANY_ID,
      category: IUserDiscountCategory.PRODUCT_GROUP,
      group: GROUP,
      method: IUserDiscountMethod.BULK,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      pricePercent: 5,
      ...overrides,
    } as any;
  }

  function sectionBody(overrides: Record<string, unknown> = {}) {
    return {
      partnerCompanyId: PARTNER_COMPANY_ID,
      category: IUserDiscountCategory.PRODUCT_GROUP,
      group: GROUP,
      method: IUserDiscountMethod.SECTION,
      compareCondition: ICompareCondition.MORE,
      range: '10000',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      pricePercent: 7,
      ...overrides,
    } as any;
  }

  describe('원자성', () => {
    it('생성 중 이력 기록이 실패하면 원본 INSERT 와 epoch 까지 되돌린다', async () => {
      jest.spyOn(historyService, 'recordCreate').mockRejectedValue(new Error('history write failed'));

      await expect(service.create(loginUser, bulkBody())).rejects.toThrow('history write failed');

      // 원본만 남으면 원장이 이 할인을 "설정된 적 없음 = 0%" 로 계산한다.
      expect(await userDiscountRepository.count({ withDeleted: true })).toBe(0);
      expect(await historyRepository.count({ withDeleted: true })).toBe(0);
      // 잠금 과정에서 만든 epoch 행도 같은 트랜잭션이라 남으면 안 된다.
      expect(await epochRepository.count()).toBe(0);
    });

    it('삭제 중 이력 기록이 실패하면 softDelete 와 epoch 증가를 되돌린다', async () => {
      await service.create(loginUser, bulkBody());

      const created = await userDiscountRepository.findOneByOrFail({ partnerCompanyId: PARTNER_COMPANY_ID });
      const epochBefore = await epochRepository.findOneByOrFail({ partnerCompanyId: PARTNER_COMPANY_ID });

      jest.spyOn(historyService, 'recordDelete').mockRejectedValue(new Error('tombstone write failed'));

      await expect(service.delete(loginUser, { id: created.id } as any)).rejects.toThrow('tombstone write failed');

      // 삭제만 반영되고 tombstone 이 없으면 원장이 죽은 할인율을 계속 적용한다.
      const stillActive = await userDiscountRepository.findOneBy({ id: created.id });
      expect(stillActive).not.toBeNull();
      expect(stillActive!.deletedAt).toBeNull();

      const epochAfter = await epochRepository.findOneByOrFail({ partnerCompanyId: PARTNER_COMPANY_ID });
      expect(String(epochAfter.epoch)).toBe(String(epochBefore.epoch));

      // 이력은 생성 구간 1건(열린 상태) 그대로여야 한다.
      const rows = await historyRepository.find();
      expect(rows).toHaveLength(1);
      expect(rows[0].validTo).toBeNull();
    });

    it('구간 마감이 실패하면 재생성 원본도 남지 않는다', async () => {
      await service.create(loginUser, bulkBody());
      const created = await userDiscountRepository.findOneByOrFail({ partnerCompanyId: PARTNER_COMPANY_ID });
      await service.delete(loginUser, { id: created.id } as any);

      // 재생성은 열린 tombstone 마감이 선행된다. 그 마감이 실패하는 상황.
      jest
        .spyOn(historyRepository, 'update')
        .mockRejectedValue(new Error('close interval failed'));

      await expect(service.create(loginUser, bulkBody({ pricePercent: 9 }))).rejects.toThrow('close interval failed');

      expect(await userDiscountRepository.count()).toBe(0); // 삭제된 원본만 남는다
      const openRows = await historyRepository.find({ where: { validTo: IsNull() } });
      expect(openRows).toHaveLength(1);
      expect(openRows[0].changeType).toBe('DELETE');
    });
  });

  describe('정책 잠금 직렬화', () => {
    it('같은 대상의 일괄·구간 동시 등록은 정확히 하나만 성공한다', async () => {
      // 잠금이 없으면 두 요청이 서로의 존재를 못 보고 둘 다 통과해,
      // 같은 대상에 일괄과 구간이 공존하는 상태가 만들어진다.
      const results = await Promise.allSettled([
        service.create(loginUser, bulkBody()),
        service.create(loginUser, sectionBody()),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      expect(await userDiscountRepository.count()).toBe(1);

      const openRows = await historyRepository.find({ where: { validTo: IsNull() } });
      expect(openRows).toHaveLength(1);
    });

    it('같은 scope 동시 등록도 하나만 성공하고 열린 구간은 하나다', async () => {
      const results = await Promise.allSettled([
        service.create(loginUser, bulkBody()),
        service.create(loginUser, bulkBody()),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await userDiscountRepository.count()).toBe(1);
      expect(await historyRepository.count()).toBe(1);
    });

    it('직렬화된 뒤에는 실패한 쪽이 남긴 흔적이 없다', async () => {
      await Promise.allSettled([
        service.create(loginUser, bulkBody()),
        service.create(loginUser, sectionBody()),
      ]);

      // 앵커는 두 키(pt1/sk1) 모두 남지만 값이 없는 잠금용 행이라 무해하다.
      // 실제 정책 상태는 원본·이력 각 1건이어야 한다.
      const epoch = await epochRepository.findOneByOrFail({ partnerCompanyId: PARTNER_COMPANY_ID });
      expect(String(epoch.epoch)).toBe('1');
    });
  });
});
