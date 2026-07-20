import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { BrandEntity } from '../../entity/brand.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { ProductEntity } from '../../entity/product.entity';
import { ProductChoiceMappingEntity } from '../../entity/product.choice.mapping.entity';
import { ProductUpdateHistoryEntity } from '../../entity/product.update.history.entity';
import { UserSyncProductEventMappingEntity } from '../../entity/user.sync.product.event.mapping.entity';
import { IPartnerCompanySettleCondition } from '../../partner_company/interface/partner.company.settle.condition';
import { IPartnerCompanySettleMethod } from '../../partner_company/interface/partner.company.settle.method';
import { IPartnerCompanyStatus } from '../../partner_company/interface/partner.company.status';
import { IProductType } from '../interface/product.type';
import { IProductUseStatus } from '../interface/product.status';
import { ProductService } from './product.service';
import { ProductChoiceService } from '../../product_choice/application/product.choice.service';
import { ProductUpdateHistoryKeyName, ProductUseStatusAutoHistoryKey } from '../domain/product.update.history.key.name';

// Finding 2 회귀 방지용 실제 MySQL 동시성 테스트.
// 초이스쿠폰의 마지막 두 구성상품을 동시에 UNUSED -> USE 로 복구하면,
// choice 행 락 이후 READ COMMITTED에서 sibling을 다시 읽어야 서로의 최신 반영을 보고
// 초이스쿠폰이 USE 로 복구된다. MySQL 기본 REPEATABLE READ 스냅샷을 그대로 쓰면
// 둘 다 상대 변경 전 상태를 보고 초이스쿠폰이 UNUSED 로 남는 stale read 가 발생할 수 있다.
dotenv.config();

jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

describe('ProductService.updatePartial 초이스쿠폰 동기화 DB concurrency', () => {
  let dataSource: DataSource;
  let productRepository: Repository<ProductEntity>;
  let service: ProductService;

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
      extra: {
        connectionLimit: 5,
      },
    });

    await dataSource.initialize();
    addTransactionalDataSource(dataSource);

    productRepository = dataSource.getRepository(ProductEntity);
    service = createService(dataSource);
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('마지막 두 구성상품을 동시에 복구하면 초이스쿠폰이 사용으로 되돌아온다', async () => {
    const fixture = await seedChoiceWithTwoUnusedComponents(dataSource);

    // 두 구성상품을 동시에 UNUSED -> USE 로 변경.
    await Promise.all([
      service.updatePartial(
        { id: fixture.operator.id } as any,
        {
          id: fixture.componentA.id,
          useStatus: IProductUseStatus.USE,
        } as any,
      ),
      service.updatePartial(
        { id: fixture.operator.id } as any,
        {
          id: fixture.componentB.id,
          useStatus: IProductUseStatus.USE,
        } as any,
      ),
    ]);

    const refreshedChoice = await productRepository.findOneByOrFail({ id: fixture.choice.id });
    const refreshedA = await productRepository.findOneByOrFail({ id: fixture.componentA.id });
    const refreshedB = await productRepository.findOneByOrFail({ id: fixture.componentB.id });

    expect(refreshedA.useStatus).toBe(IProductUseStatus.USE);
    expect(refreshedB.useStatus).toBe(IProductUseStatus.USE);
    expect(refreshedChoice.useStatus).toBe(IProductUseStatus.USE);
  });

  it('한 구성상품만 복구되면 초이스쿠폰은 미사용으로 남는다', async () => {
    const fixture = await seedChoiceWithTwoUnusedComponents(dataSource);

    await service.updatePartial(
      { id: fixture.operator.id } as any,
      {
        id: fixture.componentA.id,
        useStatus: IProductUseStatus.USE,
      } as any,
    );

    const refreshedChoice = await productRepository.findOneByOrFail({ id: fixture.choice.id });
    expect(refreshedChoice.useStatus).toBe(IProductUseStatus.UNUSED);
  });

  // 구성상품 변경(ProductService.updatePartial)과 초이스쿠폰 수정(ProductChoiceService.update)이
  // 같은 구성상품/초이스쿠폰을 동시에 건드리는 교차 시나리오.
  // 두 경로의 락 순서가 어긋나면(한쪽은 구성상품 -> 초이스쿠폰, 다른 쪽은 그 반대) 서로를 기다려
  // 데드락이 난다. 두 경로 모두 구성상품을 먼저 잠가야 이 테스트가 통과한다.
  it('구성상품 변경과 초이스쿠폰 수정을 동시에 실행해도 데드락이 나지 않는다', async () => {
    const fixture = await seedChoiceWithTwoUnusedComponents(dataSource);
    const choiceService = createChoiceService(dataSource);

    // 양쪽을 여러 번 교차 실행해 락 순서가 어긋나면 걸리도록 한다.
    for (let round = 0; round < 5; round++) {
      const nextComponentStatus = round % 2 === 0 ? IProductUseStatus.USE : IProductUseStatus.UNUSED;

      await Promise.all([
        service.updatePartial(
          { id: fixture.operator.id } as any,
          {
            id: fixture.componentA.id,
            useStatus: nextComponentStatus,
          } as any,
        ),
        choiceService.update(
          { id: fixture.operator.id } as any,
          {
            id: fixture.choice.id,
            name: `초이스쿠폰-${round}`,
            productIdList: [fixture.componentA.id, fixture.componentB.id],
            useStatus: IProductUseStatus.USE,
          } as any,
        ),
      ]);
    }

    // 데드락 없이 완주하면 성공. 최종 상태도 구성상품 기준과 어긋나지 않아야 한다.
    const refreshedChoice = await productRepository.findOneByOrFail({ id: fixture.choice.id });
    const refreshedA = await productRepository.findOneByOrFail({ id: fixture.componentA.id });
    const refreshedB = await productRepository.findOneByOrFail({ id: fixture.componentB.id });

    const expected =
      refreshedA.useStatus === IProductUseStatus.USE && refreshedB.useStatus === IProductUseStatus.USE
        ? IProductUseStatus.USE
        : IProductUseStatus.UNUSED;

    expect(refreshedChoice.useStatus).toBe(expected);
  });
});

function createChoiceService(dataSource: DataSource): ProductChoiceService {
  const service = Object.create(ProductChoiceService.prototype) as any;
  service.productRepository = dataSource.getRepository(ProductEntity);
  service.productChoiceMappingRepository = dataSource.getRepository(ProductChoiceMappingEntity);
  service.productUpdateHistoryRepository = dataSource.getRepository(ProductUpdateHistoryEntity);
  return service as ProductChoiceService;
}

function createService(dataSource: DataSource): ProductService {
  const service = Object.create(ProductService.prototype) as any;
  service.productRepository = dataSource.getRepository(ProductEntity);
  service.productChoiceMappingRepository = dataSource.getRepository(ProductChoiceMappingEntity);
  service.productUpdateHistoryRepository = dataSource.getRepository(ProductUpdateHistoryEntity);
  service.userSyncProductEventMappingRepository = dataSource.getRepository(UserSyncProductEventMappingEntity);
  return service as ProductService;
}

async function seedChoiceWithTwoUnusedComponents(dataSource: DataSource) {
  // brand.code 는 varchar(20) 이므로 접두어를 붙여도 넘지 않도록 짧은 유니크 값을 쓴다.
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  const partnerCompanyRepository = dataSource.getRepository(PartnerCompanyEntity);
  const brandRepository = dataSource.getRepository(BrandEntity);
  const productRepository = dataSource.getRepository(ProductEntity);
  const mappingRepository = dataSource.getRepository(ProductChoiceMappingEntity);

  const partnerCompany = await partnerCompanyRepository.save(
    partnerCompanyRepository.create({
      code: `pc-${suffix}`,
      corporateNumber: null,
      businessNumber: `biz-${suffix}`,
      businessName: '테스트 협력사',
      businessAddress: '서울',
      businessPhoneNumber: '0212345678',
      personName: '담당자',
      personPhoneNumber: '01000000000',
      personEmail: 'partner@example.com',
      settleCondition: IPartnerCompanySettleCondition.POST_PAYMENT,
      settleDay: 1,
      settleMethod: IPartnerCompanySettleMethod.CASH,
      maximumLimit: 1_000_000,
      bankName: '은행',
      bankNumber: '0000',
      status: IPartnerCompanyStatus.ACTIVE,
      type: null,
    } as any) as unknown as PartnerCompanyEntity,
  );
  const brand = await brandRepository.save(
    brandRepository.create({
      code: `brand-${suffix}`,
      nameKorean: '테스트 브랜드',
      nameEnglish: 'Test Brand',
      isUsed: true,
    } as any) as unknown as BrandEntity,
  );

  const buildProduct = (label: string, type: IProductType, useStatus: IProductUseStatus) =>
    productRepository.create({
      code: `product-${label}-${suffix}`,
      partnerCompanyCode: null,
      partnerCompanyId: partnerCompany.id,
      brandId: brand.id,
      name: `테스트 상품 ${label}`,
      price: 10_000,
      expireDay: 30,
      galaxiaDuration: null,
      category: 'A',
      classificationId: null,
      settleMethod: 'PER_PRODUCT',
      settlePercent: 0,
      imagePath: '',
      type,
      couponMethod: 'NONE',
      memo: null,
      useStatus,
      isCancelable: true,
      color: null,
      status: null,
    } as any) as unknown as ProductEntity;

  // 구성상품 두 개 모두 미사용, 초이스쿠폰도 자동으로 미사용된 상태에서 시작.
  const componentA = await productRepository.save(buildProduct('a', IProductType.GENERAL, IProductUseStatus.UNUSED));
  const componentB = await productRepository.save(buildProduct('b', IProductType.GENERAL, IProductUseStatus.UNUSED));
  const choice = await productRepository.save(buildProduct('choice', IProductType.CHOICE, IProductUseStatus.UNUSED));

  const operator = await productRepository.save(
    buildProduct('operator-placeholder', IProductType.GENERAL, IProductUseStatus.USE),
  );

  await mappingRepository.save([
    mappingRepository.create({ choiceProductId: choice.id, productId: componentA.id }),
    mappingRepository.create({ choiceProductId: choice.id, productId: componentB.id }),
  ]);

  // 구성상품이 미사용이라 초이스쿠폰이 자동으로 내려간 상태를 만든다.
  // 이 이력이 없으면 관리자가 직접 미사용으로 둔 것으로 보고 자동 복구 대상에서 빠진다.
  const historyRepository = dataSource.getRepository(ProductUpdateHistoryEntity);
  await historyRepository.save(
    historyRepository.create({
      productId: choice.id,
      userId: operator.id,
      key: ProductUseStatusAutoHistoryKey,
      keyName: ProductUpdateHistoryKeyName(ProductUseStatusAutoHistoryKey),
      beforeValue: IProductUseStatus.USE,
      afterValue: IProductUseStatus.UNUSED,
      reason: '구성상품 사용상태 변경에 따른 자동 반영',
    } as any) as unknown as ProductUpdateHistoryEntity,
  );

  return { partnerCompany, brand, componentA, componentB, choice, operator };
}
