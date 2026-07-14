import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { addTransactionalDataSource, deleteDataSourceByName, initializeTransactionalContext } from 'typeorm-transactional';

import { UserEntity } from '../../entity/user.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { BrandEntity } from '../../entity/brand.entity';
import { ClassificationEntity } from '../../entity/classification.entity';
import { ProductEntity } from '../../entity/product.entity';
import { OrderEntity } from '../../entity/order.entity';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';

dotenv.config();
jest.setTimeout(300_000);

const TEST_DB_NAME_PATTERN = /test/i;
const MIGRATION_SQL_PATH = path.resolve(__dirname, '../../../sql/migrations/20260629_add_partner_settle_snapshot.sql');

/**
 * migration SQL 파일을 DELIMITER 지시어를 해석해 단일 실행 가능한 statement 목록으로 분해한다.
 * (mysql CLI 전용 지시어인 DELIMITER 는 서버로 보내면 안 되므로 여기서 소비한다)
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let delimiter = ';';
  let buffer: string[] = [];

  for (const line of sql.split(/\r?\n/)) {
    const delimMatch = line.trim().match(/^DELIMITER\s+(\S+)$/i);
    if (delimMatch) {
      delimiter = delimMatch[1];
      continue;
    }
    buffer.push(line);
    const joined = buffer.join('\n').trimEnd();
    if (joined.endsWith(delimiter)) {
      const stmt = joined.slice(0, joined.length - delimiter.length).trim();
      const meaningful = stmt
        .split('\n')
        .some((l) => l.trim() !== '' && !l.trim().startsWith('--'));
      if (meaningful) {
        statements.push(stmt);
      }
      buffer = [];
    }
  }
  return statements;
}

/** migration 스크립트 전체를 한 커넥션(세션)에서 순차 실행한다. TEMPORARY TABLE 이 세션 스코프이기 때문. */
async function runMigrationScript(conn: mysql.Connection): Promise<void> {
  const sql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  for (const stmt of splitSqlStatements(sql)) {
    await conn.query(stmt);
  }
}

describe('20260629 partner settle snapshot backfill (실DB 실행 검증)', () => {
  let dataSource: DataSource;
  let scriptConn: mysql.Connection;

  // 시나리오별 mapping id 보관
  const mappingIds: Record<string, number> = {};

  let partnerCompanyId: number;
  let brandAId: number;
  let brandBId: number;
  let brandCId: number;
  let brandZId: number;
  let cls1Id: number;
  let cls2Id: number;
  let cls3Id: number;
  let orderId: number;

  async function fetchMapping(id: number): Promise<{ fee: number | null; adj: string | null }> {
    const [rows] = await scriptConn.query(
      'SELECT partner_settle_fee AS fee, partner_settle_price_adjustment AS adj FROM `order_product_mapping` WHERE id = ?',
      [id],
    );
    const row = (rows as any[])[0];
    return { fee: row.fee, adj: row.adj };
  }

  async function createProduct(overrides: Partial<Record<string, unknown>>): Promise<number> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productRepo = dataSource.getRepository(ProductEntity);
    const product = await productRepo.save(
      productRepo.create({
        code: `bf-product-${suffix}`,
        partnerCompanyId,
        brandId: brandAId,
        classificationId: null,
        name: 'backfill 상품',
        price: 10_000,
        expireDay: 30,
        category: 'GRP_NONE',
        settleMethod: 'PER_PRODUCT',
        settlePercent: 0,
        imagePath: '',
        type: 'GENERAL',
        couponMethod: 'NONE',
        useStatus: 'USE',
        isCancelable: true,
        ...overrides,
      } as any) as unknown as ProductEntity,
    );
    return product.id;
  }

  // TypeORM save() 는 insert 후 전체 컬럼을 reload SELECT 하므로, 스냅샷 컬럼이 없는
  // pre-migration 스키마 상태에서는 사용할 수 없다. raw INSERT 로 대체한다.
  async function createMapping(
    productId: number,
    overrides: { snapshotProductPrice?: number; partnerSettleFee?: number; partnerSettlePriceAdjustment?: string } = {},
  ): Promise<number> {
    const columns = [
      'order_id',
      'product_id',
      'amount',
      'top_image_path',
      'mid_image_path',
      'send_method',
      'from_phone_number',
      'send_title',
      'send_content',
      'send_request_at',
      'test_delivery_count',
    ];
    const values: unknown[] = [orderId, productId, 1, '', '', 'ALIM_TALK', '0212345678', 'backfill 제목', 'backfill 내용', new Date(), 0];
    if (overrides.snapshotProductPrice !== undefined) {
      columns.push('snapshot_product_price');
      values.push(overrides.snapshotProductPrice);
    }
    if (overrides.partnerSettleFee !== undefined) {
      columns.push('partner_settle_fee');
      values.push(overrides.partnerSettleFee);
    }
    if (overrides.partnerSettlePriceAdjustment !== undefined) {
      columns.push('partner_settle_price_adjustment');
      values.push(overrides.partnerSettlePriceAdjustment);
    }
    const [result] = await scriptConn.query(
      `INSERT INTO \`order_product_mapping\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      values,
    );
    return (result as mysql.ResultSetHeader).insertId;
  }

  async function createDiscount(overrides: Partial<Record<string, unknown>>): Promise<void> {
    const repo = dataSource.getRepository(UserDiscountEntity);
    await repo.save(
      repo.create({
        userId: null,
        partnerCompanyId,
        classificationId: null,
        primaryCategory: null,
        group: null,
        range: null,
        compareCondition: ICompareCondition.ALL,
        priceAdjustment: IPriceAdjustment.DISCOUNT,
        ...overrides,
      } as any) as unknown as UserDiscountEntity,
    );
  }

  beforeAll(async () => {
    initializeTransactionalContext();
    deleteDataSourceByName('default');

    const database = process.env.DATABASE_DATABASE;
    if (!database || !TEST_DB_NAME_PATTERN.test(database)) {
      throw new Error('DB 통합테스트는 이름에 test가 포함된 DATABASE_DATABASE에서만 실행할 수 있습니다.');
    }

    const bootstrap = await mysql.createConnection({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      multipleStatements: false,
    });
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await bootstrap.end();

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

    scriptConn = await mysql.createConnection({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database,
      multipleStatements: false,
    });

    // synchronize 가 신규 스냅샷 컬럼까지 만들어 놓으므로, 배포 전(pre-migration) 스키마를
    // 재현하기 위해 두 컬럼을 제거한다. migration 의 ALTER 가드가 다시 추가해야 한다.
    await scriptConn.query(
      'ALTER TABLE `order_product_mapping` DROP COLUMN `partner_settle_price_adjustment`, DROP COLUMN `partner_settle_fee`',
    );

    // ---- 공통 seed ----
    const suffix = Date.now();
    const userRepo = dataSource.getRepository(UserEntity);
    const pcRepo = dataSource.getRepository(PartnerCompanyEntity);
    const brandRepo = dataSource.getRepository(BrandEntity);
    const clsRepo = dataSource.getRepository(ClassificationEntity);
    const orderRepo = dataSource.getRepository(OrderEntity);

    const customer = await userRepo.save(
      userRepo.create({
        companyId: null,
        settlementCode: '',
        email: `bf-cust-${suffix}@example.com`,
        password: 'password',
        isPasswordReset: false,
        lastActivityAt: new Date(),
        authority: 'CORPORATE_ADMIN',
        status: 'USED',
        personName: 'bf-cust',
        personPhoneNumber: '01000000000',
        personEmail: `bf-cust-${suffix}@example.com`,
        personCode: `bf-cust-${suffix}`,
        corporateNumber: '',
        isHeadPerson: false,
        settleCondition: 'POST_PAYMENT',
        settleMethod: 'CASH',
        bankName: '',
        bankNumber: '',
        cardName: '',
        cardNumber: '',
        balance: 0,
        allSettleAmount: 0,
        serviceAmount: 0,
        duplicatePhoneLimit: 0,
      } as any) as unknown as UserEntity,
    );

    const pc = await pcRepo.save(
      pcRepo.create({
        code: `bf-pc-${suffix}`,
        businessNumber: `bf-biz-${suffix}`,
        businessName: 'backfill 협력사',
        businessAddress: '서울',
        businessPhoneNumber: '0212345678',
        personName: '담당자',
        personPhoneNumber: '01000000000',
        personEmail: 'partner@example.com',
        settleCondition: 'POST_PAYMENT',
        settleDay: 1,
        settleMethod: 'CASH',
        maximumLimit: 1_000_000,
        bankName: '은행',
        bankNumber: '0000',
        status: 'ACTIVE',
      } as any) as unknown as PartnerCompanyEntity,
    );
    partnerCompanyId = pc.id;

    const makeBrand = async (nameKorean: string, code: string) => {
      const brand = await brandRepo.save(
        brandRepo.create({ code, nameKorean, nameEnglish: code, isUsed: true } as any) as unknown as BrandEntity,
      );
      return brand.id;
    };
    brandAId = await makeBrand('백필브랜드A', `bfA${suffix}`.slice(0, 20));
    brandBId = await makeBrand('백필브랜드B', `bfB${suffix}`.slice(0, 20));
    brandCId = await makeBrand('백필브랜드C', `bfC${suffix}`.slice(0, 20));
    brandZId = await makeBrand('백필브랜드Z', `bfZ${suffix}`.slice(0, 20));

    const makeCls = async (name: string) => {
      const cls = await clsRepo.save(clsRepo.create({ classification: name } as any) as unknown as ClassificationEntity);
      return cls.id;
    };
    cls1Id = await makeCls('백필분류1');
    cls2Id = await makeCls('백필분류2');
    cls3Id = await makeCls('백필분류3');

    const order = await orderRepo.save(
      orderRepo.create({
        userId: customer.id,
        code: `bf-order-${suffix}`,
        status: 'DELIVERY_CONFIRMED',
        type: 'GENERAL',
        eventName: 'backfill 검증',
        registerAt: new Date(),
        sendAmount: 10_000,
        settleAmount: 0,
        isSettleBalance: false,
        isNewBillingFlow: true,
        cardSurchargeApplied: false,
        isCreditExcess: false,
      } as any) as unknown as OrderEntity,
    );
    orderId = order.id;

    // ---- 할인 조건 seed (findMatchingDiscount 케이스 재현) ----
    // BRAND BULK: 백필브랜드A → 10% DISCOUNT
    await createDiscount({
      category: IUserDiscountCategory.BRAND,
      method: IUserDiscountMethod.BULK,
      primaryCategory: '백필브랜드A',
      pricePercent: 10,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    // BRAND SECTION: 백필브랜드B → [5000 이상(OVER) ~ 20000 이하(LESS)] 구간 7% DISCOUNT
    await createDiscount({
      category: IUserDiscountCategory.BRAND,
      method: IUserDiscountMethod.SECTION,
      primaryCategory: '백필브랜드B',
      range: '5000',
      compareCondition: ICompareCondition.MORE, // 'OVER'
      pricePercent: 7,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    await createDiscount({
      category: IUserDiscountCategory.BRAND,
      method: IUserDiscountMethod.SECTION,
      primaryCategory: '백필브랜드B',
      range: '20000',
      compareCondition: ICompareCondition.LESS,
      pricePercent: 3,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    // CATEGORY BULK: 분류1 → 5% DISCOUNT
    await createDiscount({
      category: IUserDiscountCategory.CATEGORY,
      method: IUserDiscountMethod.BULK,
      classificationId: cls1Id,
      pricePercent: 5,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    // PRODUCT_GROUP BULK: GROUP_X → 8% ADDITIONAL
    await createDiscount({
      category: IUserDiscountCategory.PRODUCT_GROUP,
      method: IUserDiscountMethod.BULK,
      group: 'GROUP_X',
      pricePercent: 8,
      priceAdjustment: IPriceAdjustment.ADDITIONAL,
    });
    // CATEGORY(분류2, 5% DISCOUNT) + PRODUCT_GROUP(GROUP_Y, 9% DISCOUNT) 동시매칭 → 높은 9% 채택
    await createDiscount({
      category: IUserDiscountCategory.CATEGORY,
      method: IUserDiscountMethod.BULK,
      classificationId: cls2Id,
      pricePercent: 5,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    await createDiscount({
      category: IUserDiscountCategory.PRODUCT_GROUP,
      method: IUserDiscountMethod.BULK,
      group: 'GROUP_Y',
      pricePercent: 9,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    // 삭제된 할인(백필브랜드Z 50%)은 backfill 에서 제외되어야 함
    const discountRepo = dataSource.getRepository(UserDiscountEntity);
    const deletedDiscount = await discountRepo.save(
      discountRepo.create({
        userId: null,
        partnerCompanyId,
        category: IUserDiscountCategory.BRAND,
        method: IUserDiscountMethod.BULK,
        primaryCategory: '백필브랜드Z',
        classificationId: null,
        group: null,
        range: null,
        compareCondition: ICompareCondition.ALL,
        pricePercent: 50,
        priceAdjustment: IPriceAdjustment.DISCOUNT,
      } as any) as unknown as UserDiscountEntity,
    );
    await discountRepo.softDelete(deletedDiscount.id);

    // ---- 대상 mapping seed (partner_settle_* 컬럼이 없는 상태이므로 전부 미박제 상태) ----
    mappingIds.brandBulk = await createMapping(await createProduct({ brandId: brandAId }));
    mappingIds.brandSectionIn = await createMapping(await createProduct({ brandId: brandBId, price: 10_000 }));
    mappingIds.brandSectionOut = await createMapping(await createProduct({ brandId: brandBId, price: 30_000 }));
    mappingIds.snapshotPriority = await createMapping(await createProduct({ brandId: brandBId, price: 30_000 }), {
      snapshotProductPrice: 10_000,
    });
    mappingIds.categoryBulk = await createMapping(
      await createProduct({ brandId: brandCId, classificationId: cls1Id }),
    );
    mappingIds.groupBulk = await createMapping(await createProduct({ brandId: brandCId, category: 'GROUP_X' }));
    mappingIds.categoryVsGroup = await createMapping(
      await createProduct({ brandId: brandCId, classificationId: cls2Id, category: 'GROUP_Y' }),
    );
    mappingIds.noMatch = await createMapping(await createProduct({ brandId: brandZId }));
  });

  afterAll(async () => {
    if (scriptConn) {
      await scriptConn.end();
    }
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('1차 실행: 컬럼 추가 + backfill 이 findMatchingDiscount 규칙대로 박제된다', async () => {
    await runMigrationScript(scriptConn);

    // BRAND BULK 최우선
    expect(await fetchMapping(mappingIds.brandBulk)).toEqual({ fee: 10, adj: 'DISCOUNT' });
    // BRAND SECTION 구간 내(5000 이상 ~ 20000 이하, 10000)
    expect(await fetchMapping(mappingIds.brandSectionIn)).toEqual({ fee: 7, adj: 'DISCOUNT' });
    // BRAND SECTION 구간 밖(30000) + 폴백 없음 → 할인 없음 확정(0/NULL)
    expect(await fetchMapping(mappingIds.brandSectionOut)).toEqual({ fee: 0, adj: null });
    // snapshot_product_price(10000) 가 product.price(30000) 보다 우선
    expect(await fetchMapping(mappingIds.snapshotPriority)).toEqual({ fee: 7, adj: 'DISCOUNT' });
    // CATEGORY BULK
    expect(await fetchMapping(mappingIds.categoryBulk)).toEqual({ fee: 5, adj: 'DISCOUNT' });
    // PRODUCT_GROUP BULK (ADDITIONAL 방향 유지)
    expect(await fetchMapping(mappingIds.groupBulk)).toEqual({ fee: 8, adj: 'ADDITIONAL' });
    // CATEGORY(5%) vs PRODUCT_GROUP(9%) 동시매칭 · 같은 방향 → 높은 9% 채택
    expect(await fetchMapping(mappingIds.categoryVsGroup)).toEqual({ fee: 9, adj: 'DISCOUNT' });
    // 삭제된 할인만 있는 브랜드 → 매칭 없음 → 0/NULL (deleted_at 제외 검증 포함)
    expect(await fetchMapping(mappingIds.noMatch)).toEqual({ fee: 0, adj: null });
  });

  it('classification_id 가 양쪽 NULL 인 CATEGORY 할인도 findMatchingDiscount 처럼 매칭된다', async () => {
    // findMatchingDiscount 의 `d.classificationId === product.classificationId` 는
    // 둘 다 null 이면 매칭이다. SQL 이 `=` 를 쓰면 NULL 비교가 UNKNOWN 이 되어 누락된다.
    await createDiscount({
      category: IUserDiscountCategory.CATEGORY,
      method: IUserDiscountMethod.BULK,
      classificationId: null,
      pricePercent: 6,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    // 브랜드 할인 없음(백필브랜드Z) + classification 없음 + 상품군 할인 없음 → CATEGORY(NULL) 만 매칭
    const nullClsMappingId = await createMapping(
      await createProduct({ brandId: brandZId, classificationId: null, category: 'GRP_NONE' }),
    );

    await runMigrationScript(scriptConn);

    expect(await fetchMapping(nullClsMappingId)).toEqual({ fee: 6, adj: 'DISCOUNT' });

    // 이후 테스트가 기대하는 "할인 없음" 기준선을 되돌린다
    await dataSource
      .getRepository(UserDiscountEntity)
      .createQueryBuilder()
      .softDelete()
      .where('category = :c AND method = :m AND classification_id IS NULL', {
        c: IUserDiscountCategory.CATEGORY,
        m: IUserDiscountMethod.BULK,
      })
      .execute();
  });

  it('브랜드명 대소문자가 다르면 findMatchingDiscount 처럼 매칭되지 않는다', async () => {
    // 컬럼 기본 collation(utf8mb4_unicode_ci)은 대소문자를 무시하므로 `=` 로 두면 SQL 만 매칭한다.
    // TS 의 `d.primaryCategory === product.brand?.nameKorean` 는 정확 일치라 매칭되지 않아야 한다.
    const brandRepo = dataSource.getRepository(BrandEntity);
    const suffix = `${Date.now()}`;
    const caseBrand = await brandRepo.save(
      brandRepo.create({
        code: `bfCase${suffix}`.slice(0, 20),
        nameKorean: 'Case Brand',
        nameEnglish: 'CaseBrand',
        isUsed: true,
      } as any) as unknown as BrandEntity,
    );
    // 할인은 소문자로 등록 → 바이너리 비교면 불일치
    await createDiscount({
      category: IUserDiscountCategory.BRAND,
      method: IUserDiscountMethod.BULK,
      primaryCategory: 'case brand',
      pricePercent: 30,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    const caseMappingId = await createMapping(await createProduct({ brandId: caseBrand.id }));

    await runMigrationScript(scriptConn);

    expect(await fetchMapping(caseMappingId)).toEqual({ fee: 0, adj: null });

    await dataSource
      .getRepository(UserDiscountEntity)
      .createQueryBuilder()
      .softDelete()
      .where('primary_category = :p', { p: 'case brand' })
      .execute();
  });

  it('brand 가 soft-delete 되면 브랜드 할인을 무시하고 상품군 할인으로 폴백한다', async () => {
    // order.service.ts 는 relations 를 withDeleted 없이 로드하므로 삭제된 brand 는 보이지 않는다.
    // → product.brand 가 undefined → 브랜드 할인 미매칭 → CATEGORY/PRODUCT_GROUP 폴백.
    const brandRepo = dataSource.getRepository(BrandEntity);
    const suffix = `${Date.now()}`;
    const deadBrand = await brandRepo.save(
      brandRepo.create({
        code: `bfDead${suffix}`.slice(0, 20),
        nameKorean: '삭제된브랜드',
        nameEnglish: 'DeadBrand',
        isUsed: true,
      } as any) as unknown as BrandEntity,
    );
    // 브랜드 할인 20% (삭제된 브랜드라 적용되면 안 됨)
    await createDiscount({
      category: IUserDiscountCategory.BRAND,
      method: IUserDiscountMethod.BULK,
      primaryCategory: '삭제된브랜드',
      pricePercent: 20,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    // 폴백 대상 상품군 할인 4%
    await createDiscount({
      category: IUserDiscountCategory.PRODUCT_GROUP,
      method: IUserDiscountMethod.BULK,
      group: 'GROUP_FALLBACK',
      pricePercent: 4,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    const mappingId = await createMapping(
      await createProduct({ brandId: deadBrand.id, category: 'GROUP_FALLBACK' }),
    );
    await brandRepo.softDelete(deadBrand.id);

    await runMigrationScript(scriptConn);

    expect(await fetchMapping(mappingId)).toEqual({ fee: 4, adj: 'DISCOUNT' });

    await dataSource
      .getRepository(UserDiscountEntity)
      .createQueryBuilder()
      .softDelete()
      .where('primary_category = :p OR `group` = :g', { p: '삭제된브랜드', g: 'GROUP_FALLBACK' })
      .execute();
  });

  it('partner_company 가 soft-delete 되면 할인 조건 자체가 보이지 않아 0/null 로 확정된다', async () => {
    // product.partnerCompany 가 undefined → userDiscounts 가 [] → findMatchingDiscount 가 즉시 null.
    const pcRepo = dataSource.getRepository(PartnerCompanyEntity);
    const suffix = `${Date.now()}`;
    const deadPc = await pcRepo.save(
      pcRepo.create({
        code: `bf-dead-pc-${suffix}`,
        businessNumber: `bf-dead-biz-${suffix}`,
        businessName: '삭제된 협력사',
        businessAddress: '서울',
        businessPhoneNumber: '0212345678',
        personName: '담당자',
        personPhoneNumber: '01000000000',
        personEmail: 'dead@example.com',
        settleCondition: 'POST_PAYMENT',
        settleDay: 1,
        settleMethod: 'CASH',
        maximumLimit: 1_000_000,
        bankName: '은행',
        bankNumber: '0000',
        status: 'ACTIVE',
      } as any) as unknown as PartnerCompanyEntity,
    );
    // 삭제될 협력사에 브랜드 할인 25% 등록 (적용되면 안 됨)
    const discountRepo = dataSource.getRepository(UserDiscountEntity);
    await discountRepo.save(
      discountRepo.create({
        userId: null,
        partnerCompanyId: deadPc.id,
        category: IUserDiscountCategory.BRAND,
        method: IUserDiscountMethod.BULK,
        primaryCategory: '백필브랜드A',
        classificationId: null,
        group: null,
        range: null,
        compareCondition: ICompareCondition.ALL,
        pricePercent: 25,
        priceAdjustment: IPriceAdjustment.DISCOUNT,
      } as any) as unknown as UserDiscountEntity,
    );
    const mappingId = await createMapping(
      await createProduct({ partnerCompanyId: deadPc.id, brandId: brandAId }),
    );
    await pcRepo.softDelete(deadPc.id);

    await runMigrationScript(scriptConn);

    expect(await fetchMapping(mappingId)).toEqual({ fee: 0, adj: null });
  });

  it('재실행(멱등성): 이미 박제된 행은 그대로, 새 NULL 행만 backfill 되고 새 앱이 쓴 값은 보존된다', async () => {
    // migration 도중/이후 상황 재현:
    // - 구버전 앱이 쓴 것 같은 미박제(NULL) 행
    const oldAppMappingId = await createMapping(await createProduct({ brandId: brandAId }));
    // - 새 앱이 주문 생성 시점에 직접 박제한 행 (backfill 이 덮어쓰면 안 됨)
    const newAppMappingId = await createMapping(await createProduct({ brandId: brandAId }), {
      partnerSettleFee: 42,
      partnerSettlePriceAdjustment: 'ADDITIONAL',
    });
    const before = await fetchMapping(mappingIds.categoryVsGroup);

    // 스크립트 전체 재실행 — ALTER 가드 덕에 duplicate column 없이 통과해야 한다
    await runMigrationScript(scriptConn);

    expect(await fetchMapping(oldAppMappingId)).toEqual({ fee: 10, adj: 'DISCOUNT' });
    expect(await fetchMapping(newAppMappingId)).toEqual({ fee: 42, adj: 'ADDITIONAL' });
    expect(await fetchMapping(mappingIds.categoryVsGroup)).toEqual(before);
  });

  it('backfill 도중 할인 조건이 변경되어도 시작 시점 스냅샷 기준으로만 박제된다 (삭제된 조건 제외 포함)', async () => {
    // 시작 시점 스냅샷(temp table) 사용을 직접적으로 재현하려면 스크립트 실행 중간에 끼어들어야
    // 하지만 단일 세션 순차 실행이라 불가능하므로, 대신 "삭제된 할인 조건이 절대 반영되지 않음"
    // (deleted_at IS NULL 필터가 스냅샷 구체화 시점에 적용)은 1차 실행의 noMatch 케이스로 검증했고,
    // 여기서는 backfill 이후 할인 조건을 바꿔도 이미 박제된 값이 변하지 않음을 검증한다.
    const discountRepo = dataSource.getRepository(UserDiscountEntity);
    await discountRepo
      .createQueryBuilder()
      .update()
      .set({ pricePercent: 99 })
      .where('primary_category = :b', { b: '백필브랜드A' })
      .execute();

    await runMigrationScript(scriptConn);

    // 이미 박제된 행은 할인 조건 변경의 영향을 받지 않는다 (재실행해도 NULL 행만 대상)
    expect(await fetchMapping(mappingIds.brandBulk)).toEqual({ fee: 10, adj: 'DISCOUNT' });

    // 원복
    await discountRepo
      .createQueryBuilder()
      .update()
      .set({ pricePercent: 10 })
      .where('primary_category = :b', { b: '백필브랜드A' })
      .execute();
  });

  it('CATEGORY/PRODUCT_GROUP 방향 충돌 행은 findMatchingDiscount처럼 즉시 SIGNAL 로 차단되고 같은 트랜잭션 변경도 롤백된다', async () => {
    // 방향 충돌: CATEGORY(분류3, DISCOUNT) vs PRODUCT_GROUP(GROUP_C, ADDITIONAL)
    await createDiscount({
      category: IUserDiscountCategory.CATEGORY,
      method: IUserDiscountMethod.BULK,
      classificationId: cls3Id,
      pricePercent: 5,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    });
    await createDiscount({
      category: IUserDiscountCategory.PRODUCT_GROUP,
      method: IUserDiscountMethod.BULK,
      group: 'GROUP_C',
      pricePercent: 7,
      priceAdjustment: IPriceAdjustment.ADDITIONAL,
    });
    const conflictMappingId = await createMapping(
      await createProduct({ brandId: brandCId, classificationId: cls3Id, category: 'GROUP_C' }),
    );
    // 같은 실행에 섞인 정상 행은 충돌 차단과 무관하게 박제되어야 한다
    const companionMappingId = await createMapping(await createProduct({ brandId: brandAId }));

    let error: any = null;
    try {
      await runMigrationScript(scriptConn);
    } catch (e) {
      error = e;
    }

    expect(error).not.toBeNull();
    expect(String(error.sqlMessage || error.message)).toContain('priceAdjustment conflict');

    // 충돌 행: 자동 확정 금지 → NULL 유지
    expect(await fetchMapping(conflictMappingId)).toEqual({ fee: null, adj: null });

    // 같은 backfill 트랜잭션에서 처리되던 정상 행도 rollback 되어 아직 미박제 상태여야 한다
    expect(await fetchMapping(companionMappingId)).toEqual({ fee: null, adj: null });
  });

  it('구버전 앱이 backfill 이후 끼워넣은 NULL 행도 전체 테이블 검증 SIGNAL 로 차단된다', async () => {
    // 직전 테스트의 충돌 할인 조건 제거 → 충돌 행도 이번 실행에서 정상 판정되도록 정리
    const discountRepo = dataSource.getRepository(UserDiscountEntity);
    await discountRepo
      .createQueryBuilder()
      .softDelete()
      .where('`group` = :g OR classification_id = :c', { g: 'GROUP_C', c: cls3Id })
      .execute();

    // 정리 후 재실행 → 이번엔 통과해야 한다 (충돌 행은 이제 조건 없음 → 0/NULL 확정)
    await runMigrationScript(scriptConn);

    // 이제 "구버전 앱이 검증 직전 새 주문을 NULL 로 insert" 상황 재현:
    // target 구체화 이후 생긴 NULL 행 → 전체 테이블 검증이 차단해야 한다.
    // (스크립트 실행 중간에 insert 할 수 없으므로, backfill 은 이미 끝났고 NULL 행만 남은 상태를 만들어
    //  검증 프로시저 단독 호출로 동일 조건을 재현한다)
    const lateNullMappingId = await createMapping(await createProduct({ brandId: brandAId }));

    const sql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
    const statements = splitSqlStatements(sql);
    const assertCreateIdx = statements.findIndex((s) => /CREATE\s+PROCEDURE\s+assert_partner_settle_snapshot_backfill/i.test(s));
    expect(assertCreateIdx).toBeGreaterThan(-1);

    await scriptConn.query('DROP PROCEDURE IF EXISTS assert_partner_settle_snapshot_backfill');
    await scriptConn.query(statements[assertCreateIdx]);

    let error: any = null;
    try {
      await scriptConn.query('CALL assert_partner_settle_snapshot_backfill()');
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
    expect(String(error.sqlMessage || error.message)).toContain('unresolved NULL rows remain');

    await scriptConn.query('DROP PROCEDURE IF EXISTS assert_partner_settle_snapshot_backfill');

    // 후속 정리: 재실행하면 해당 행도 정상 backfill 되어 스크립트가 통과한다
    await runMigrationScript(scriptConn);
    expect(await fetchMapping(lateNullMappingId)).toEqual({ fee: 10, adj: 'DISCOUNT' });
  });
});
