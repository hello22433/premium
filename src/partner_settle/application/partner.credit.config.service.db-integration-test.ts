import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCreditConfigEntity } from '../../entity/partner.credit.config.entity';
import { PartnerCreditConfigHistoryEntity } from '../../entity/partner.credit.config.history.entity';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { PartnerCreditConfigService } from './partner.credit.config.service';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

/**
 * 여신 설정 조회/변경의 DB·트랜잭션 계약을 실 MySQL 로 검증한다 (정본 §5.3 · §9).
 *
 * optimistic lock 409·최초 생성 경합·all-or-nothing rollback·CHECK(>=0)·history append 는
 * repository mock 으로는 못 잡는다(트랜잭션·UNIQUE·CHECK 가 DB 에서만 걸림). 그래서 실 DB 로 본다.
 * `synchronize` 는 CHECK 를 만들지 않으므로 마이그레이션과 같은 CHECK 를 여기서 직접 적용한다.
 */
describe('PartnerCreditConfigService — 여신 설정 DB 통합', () => {
  let dataSource: DataSource;
  let service: PartnerCreditConfigService;
  let partnerId: number;
  let nonTargetPartnerId: number;

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
    addTransactionalDataSource(dataSource);

    // 마이그레이션과 같은 CHECK (synchronize 는 CHECK 를 만들지 않는다).
    await dataSource.query(`
      ALTER TABLE \`partner_credit_config\`
        ADD CONSTRAINT \`chk_pcc_insurance_nonneg\` CHECK (\`insurance_amount\` >= 0),
        ADD CONSTRAINT \`chk_pcc_prepaid_nonneg\`   CHECK (\`prepaid_amount\` >= 0),
        ADD CONSTRAINT \`chk_pcc_etc_nonneg\`       CHECK (\`etc_amount\` >= 0)
    `);

    const pcRepo = dataSource.getRepository(PartnerCompanyEntity);
    const partner = await pcRepo.save(
      pcRepo.create({
        code: `DAOU-${Date.now()}`,
        corporateNumber: null,
        businessNumber: '000',
        businessName: '다우기술',
        businessAddress: '-',
        businessPhoneNumber: '-',
        personName: '-',
        personPhoneNumber: '-',
        personEmail: '-',
        settleCondition: 'POST_PAYMENT' as any,
        settleDay: 1,
        settleMethod: 'CASH' as any,
        maximumLimit: 0,
        bankName: '-',
        bankNumber: '-',
        status: 'ACTIVE' as any,
        validityStartsNextDay: true,
        type: IPartnerCompanyType.DAOU,
      }),
    );
    partnerId = partner.id;

    // 비대상 type(GS_M_BIZ) — PUT 이 400 으로 거부하는지 검증용.
    const nonTarget = await pcRepo.save(
      pcRepo.create({
        code: `GSMBIZ-${Date.now()}`,
        corporateNumber: null,
        businessNumber: '001',
        businessName: 'GS 엠비즈',
        businessAddress: '-',
        businessPhoneNumber: '-',
        personName: '-',
        personPhoneNumber: '-',
        personEmail: '-',
        settleCondition: 'POST_PAYMENT' as any,
        settleDay: 1,
        settleMethod: 'CASH' as any,
        maximumLimit: 0,
        bankName: '-',
        bankNumber: '-',
        status: 'ACTIVE' as any,
        validityStartsNextDay: true,
        type: IPartnerCompanyType.GS_M_BIZ,
      }),
    );
    nonTargetPartnerId = nonTarget.id;

    service = new PartnerCreditConfigService(
      dataSource.getRepository(PartnerCreditConfigEntity),
      dataSource.getRepository(PartnerCreditConfigHistoryEntity),
      pcRepo,
    );
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM `partner_credit_config_history`');
    await dataSource.query('DELETE FROM `partner_credit_config`');
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  const item = (over: Record<string, unknown> = {}) => ({
    subItemKey: 'NONE',
    insuranceAmount: '100',
    prepaidAmount: '200',
    etcAmount: '30',
    expectedVersion: null as number | null,
    ...over,
  });

  it('최초 생성 → version 0 · CREATE history · monthlyLimit 계산(DAOU=보증+선입+기타)', async () => {
    const result = await service.putConfig(partnerId, [item()], 1);
    expect(result).toEqual([{ subItemKey: 'NONE', version: 0 }]);

    const view = await service.getConfig(partnerId);
    expect(view).toEqual([
      {
        subItemKey: 'NONE',
        insuranceAmount: '100',
        prepaidAmount: '200',
        etcAmount: '30',
        monthlyLimit: '330',
        version: 0,
      },
    ]);

    const history = await dataSource.getRepository(PartnerCreditConfigHistoryEntity).find();
    expect(history).toHaveLength(1);
    expect(history[0].action).toBe('CREATE');
    expect(history[0].beforeInsuranceAmount).toBeNull();
    expect(history[0].afterInsuranceAmount).toBe('100');
  });

  it('갱신 → version+1 · UPDATE history(before 스냅샷)', async () => {
    await service.putConfig(partnerId, [item()], 1);
    const updated = await service.putConfig(
      partnerId,
      [item({ insuranceAmount: '500', expectedVersion: 0 })],
      2,
    );
    expect(updated).toEqual([{ subItemKey: 'NONE', version: 1 }]);

    const history = await dataSource
      .getRepository(PartnerCreditConfigHistoryEntity)
      .find({ order: { id: 'ASC' } });
    expect(history.map((h) => h.action)).toEqual(['CREATE', 'UPDATE']);
    expect(history[1].beforeInsuranceAmount).toBe('100');
    expect(history[1].afterInsuranceAmount).toBe('500');
  });

  it('stale expectedVersion → 409', async () => {
    await service.putConfig(partnerId, [item()], 1); // version 0
    await expect(
      service.putConfig(partnerId, [item({ expectedVersion: 5 })], 1),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('expectedVersion=null 인데 이미 존재 → 409', async () => {
    await service.putConfig(partnerId, [item()], 1);
    await expect(
      service.putConfig(partnerId, [item({ expectedVersion: null })], 1),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('expectedVersion 지정인데 대상 없음 → 409', async () => {
    await expect(
      service.putConfig(partnerId, [item({ expectedVersion: 0 })], 1),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('음수 금액 문자열 → 400 (canonical 위반)', async () => {
    await expect(
      service.putConfig(partnerId, [item({ insuranceAmount: '-1' })], 1),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('all-or-nothing: 배치 중 한 item 이 stale 면 전체 rollback', async () => {
    await service.putConfig(partnerId, [item({ subItemKey: 'A' })], 1); // A version 0

    await expect(
      service.putConfig(
        partnerId,
        [
          item({ subItemKey: 'B' }), // 신규 (성공 가능)
          item({ subItemKey: 'A', expectedVersion: 5 }), // stale → 409
        ],
        1,
      ),
    ).rejects.toMatchObject({ status: 409 });

    // B 가 커밋되지 않았어야 한다(rollback).
    const rows = await dataSource
      .getRepository(PartnerCreditConfigEntity)
      .find({ where: { partnerCompanyId: partnerId } });
    expect(rows.map((r) => r.subItemKey).sort()).toEqual(['A']);
  });

  it('배치 내 중복 subItemKey → 400', async () => {
    await expect(
      service.putConfig(partnerId, [item({ subItemKey: 'X' }), item({ subItemKey: 'X' })], 1),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('동시 최초 생성 경합 → 한쪽만 성공, 패자 409 (UNIQUE)', async () => {
    const results = await Promise.allSettled([
      service.putConfig(partnerId, [item({ subItemKey: 'RACE' })], 1),
      service.putConfig(partnerId, [item({ subItemKey: 'RACE' })], 2),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409 });

    const rows = await dataSource
      .getRepository(PartnerCreditConfigEntity)
      .find({ where: { partnerCompanyId: partnerId, subItemKey: 'RACE' } });
    expect(rows).toHaveLength(1);
  });

  it('여신 표 비대상 type(GS_M_BIZ) 설정 PUT → 400 (GET 이 깨지기 전에 차단)', async () => {
    await expect(
      service.putConfig(nonTargetPartnerId, [item()], 1),
    ).rejects.toMatchObject({ status: 400 });

    const rows = await dataSource
      .getRepository(PartnerCreditConfigEntity)
      .find({ where: { partnerCompanyId: nonTargetPartnerId } });
    expect(rows).toHaveLength(0);
  });
});
