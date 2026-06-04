import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { BrandEntity } from '../../entity/brand.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { ProductEntity } from '../../entity/product.entity';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { UserEntity } from '../../entity/user.entity';
import { WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../interface/order.send.method';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { OrderService } from './order.service';
import { IPartnerCompanySettleCondition } from '../../partner_company/interface/partner.company.settle.condition';
import { IPartnerCompanySettleMethod } from '../../partner_company/interface/partner.company.settle.method';
import { IPartnerCompanyStatus } from '../../partner_company/interface/partner.company.status';
import { IProductType } from '../../product/interface/product.type';
import { IProductUseStatus } from '../../product/interface/product.status';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../user/interface/user.settle.method';
import { IUserStatus } from '../../user/interface/user.status';

dotenv.config();

jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

describe('OrderService.deliveryConfirmed DB concurrency', () => {
  let dataSource: DataSource;
  let orderRepository: Repository<OrderEntity>;
  let orderDeliveryRepository: Repository<OrderDeliveryEntity>;
  let userRepository: Repository<UserEntity>;
  let service: OrderService;

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
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
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

    orderRepository = dataSource.getRepository(OrderEntity);
    orderDeliveryRepository = dataSource.getRepository(OrderDeliveryEntity);
    userRepository = dataSource.getRepository(UserEntity);

    service = createService(dataSource);
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('동일 주문 발송확정 동시 요청은 실제 row lock과 상태 조건으로 한 번만 차감한다', async () => {
    const fixture = await seedReviewCompleteOrder(dataSource);
    const delayedDeliveryRepository = wrapFirstDeliverySaveWithDelay(orderDeliveryRepository, 300);
    (service as any).orderDeliveryRepository = delayedDeliveryRepository;

    const results = await Promise.allSettled([
      service.deliveryConfirmed(
        { id: fixture.operator.id, authority: IUserAuthority.OPERATION_ADMIN } as any,
        { id: fixture.order.id } as any,
      ),
      service.deliveryConfirmed(
        { id: fixture.operator.id, authority: IUserAuthority.OPERATION_ADMIN } as any,
        { id: fixture.order.id } as any,
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BadRequestException);

    const refreshedOrder = await orderRepository.findOneByOrFail({ id: fixture.order.id });
    const refreshedUser = await userRepository.findOneByOrFail({ id: fixture.customer.id });
    const refreshedDeliveries = await orderDeliveryRepository.find({
      where: { orderProductMappingId: fixture.mapping.id },
    });

    expect(refreshedOrder.status).toBe(IOrderStatus.DELIVERY_CONFIRMED);
    expect(refreshedOrder.settleAmount).toBe(fixture.expectedSettleAmount);
    expect(refreshedUser.balance).toBe(fixture.initialBalance - fixture.expectedSettleAmount);
    expect(refreshedUser.allSettleAmount).toBe(0);
    expect(refreshedDeliveries).toHaveLength(1);
    expect(refreshedDeliveries[0].status).toBe(IOrderDeliveryStatus.WAIT);
  });
});

function createService(dataSource: DataSource): OrderService {
  const service = Object.create(OrderService.prototype) as any;
  service.orderRepository = dataSource.getRepository(OrderEntity);
  service.userRepository = dataSource.getRepository(UserEntity);
  service.userCompanyRepository = {
    createQueryBuilder: jest.fn(),
    update: jest.fn(),
  };
  service.userDiscountRepository = dataSource.getRepository(UserDiscountEntity);
  service.orderProductMappingRepository = dataSource.getRepository(OrderProductMappingEntity);
  service.orderDeliveryRepository = dataSource.getRepository(OrderDeliveryEntity);
  service.logger = {
    debug: jest.fn(),
    warn: jest.fn(),
  };
  service.cryptoCipher = { safeDecryptDeliveryTarget: (value: string) => value };
  service.ssgEventService = { confirmEventBalance: jest.fn() };
  service.walletCutoverConfig = {
    get pr2DeliveryLifecycleMode() {
      return WalletCutoverMode.LEGACY;
    },
  };
  service.walletManagedPredicate = { isWalletManaged: jest.fn() };
  service.walletAccountResolverService = { resolveForOrder: jest.fn() };
  service.paymentAllocationService = { allocate: jest.fn() };
  service.orderConfirmationWalletService = { persistAllocation: jest.fn() };
  service.orderConfirmationReleaseService = { releaseConfirmation: jest.fn() };
  service.shadowMismatchClassifierService = { classify: jest.fn() };
  return service as OrderService;
}

async function seedReviewCompleteOrder(dataSource: DataSource) {
  const suffix = Date.now();
  const userRepository = dataSource.getRepository(UserEntity);
  const partnerCompanyRepository = dataSource.getRepository(PartnerCompanyEntity);
  const brandRepository = dataSource.getRepository(BrandEntity);
  const productRepository = dataSource.getRepository(ProductEntity);
  const orderRepository = dataSource.getRepository(OrderEntity);
  const mappingRepository = dataSource.getRepository(OrderProductMappingEntity);
  const deliveryRepository = dataSource.getRepository(OrderDeliveryEntity);

  const operator = await userRepository.save(
    userRepository.create(buildUser(`operator-${suffix}`, IUserAuthority.OPERATION_ADMIN, 0)),
  );
  const initialBalance = 50_000;
  const customer = await userRepository.save(
    userRepository.create(buildUser(`customer-${suffix}`, IUserAuthority.CORPORATE_ADMIN, initialBalance)),
  );
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
  const expectedSettleAmount = 10_000;
  const product = await productRepository.save(
    productRepository.create({
      code: `product-${suffix}`,
      partnerCompanyCode: null,
      partnerCompanyId: partnerCompany.id,
      brandId: brand.id,
      name: '테스트 상품',
      price: expectedSettleAmount,
      expireDay: 30,
      galaxiaDuration: null,
      category: 'A',
      classificationId: null,
      settleMethod: 'PER_PRODUCT',
      settlePercent: 0,
      imagePath: '',
      type: IProductType.GENERAL,
      couponMethod: 'NONE',
      memo: null,
      useStatus: IProductUseStatus.USE,
      isCancelable: true,
      color: null,
      status: null,
    } as any) as unknown as ProductEntity,
  );
  const order = await orderRepository.save(
    orderRepository.create({
      userId: customer.id,
      operationUserId: null,
      clientUserId: null,
      code: `order-${suffix}`,
      status: IOrderStatus.REVIEW_COMPLETE,
      type: IOrderType.GENERAL,
      eventName: '테스트 이벤트',
      registerAt: new Date(),
      sendAmount: expectedSettleAmount,
      settleAmount: 0,
      settledAmountSnapshot: null,
      ssgEventId: null,
      settleStatus: null,
      isSettleBalance: false,
      isNewBillingFlow: true,
      cardSurchargeApplied: false,
      isCreditExcess: false,
      cancelReason: null,
      canceledAt: null,
    } as any) as unknown as OrderEntity,
  );
  const mapping = await mappingRepository.save(
    mappingRepository.create({
      orderId: order.id,
      productId: product.id,
      amount: 1,
      topImagePath: '',
      midImagePath: '',
      settleDiscountType: null,
      priceAdjustment: null,
      fee: null,
      sendMethod: IOrderSendMethod.ALIM_TALK,
      sendTailText: null,
      requestToDestroyPersonalInfoDay: null,
      fromPhoneNumber: '0212345678',
      sendTitle: '테스트 제목',
      sendContent: '테스트 내용',
      fromEmail: null,
      emailSendType: null,
      useEmailContent: null,
      sendRequestAt: new Date(),
      sendType: null,
      encourageDay: null,
      galaxiaDuration: null,
    } as any) as unknown as OrderProductMappingEntity,
  );
  await deliveryRepository.save(
    deliveryRepository.create({
      status: IOrderDeliveryStatus.TEMP,
      orderProductMappingId: mapping.id,
      deliveryMethod: IOrderSendMethod.ALIM_TALK,
      deliveryTarget: '01011112222',
      originalDeliveryTarget: '01011112222',
      imagePath: null,
      replaceCharacter1: null,
      replaceCharacter2: null,
      replaceCharacter3: null,
      sendRequestAt: new Date(),
      actualSendAt: null,
      expireAt: null,
      transactionId: null,
      externalTrId: null,
      barCode: null,
      personalCode: null,
      ssgEventId: null,
      emailCouponStatus: null,
      emailReceiverPhone: null,
      ssgTransactionId: null,
      choiceSelectProductId: null,
      couponIssuedAt: null,
      couponNum: null,
      tradeAt: null,
      tradePlace: null,
      encourageAt: null,
      resendAt: null,
      replacedFromId: null,
      failedAt: null,
      claimedAt: null,
      discardedAt: null,
      refundedAt: null,
      refundStatus: null,
      refundRatio: null,
      settleFee: null,
      settlePriceAdjustment: null,
      settleDiscountType: null,
      refundRegisterAt: null,
      bankName: null,
      bankAccount: null,
      bankAccountOwner: null,
      refundAt: null,
      approveAt: null,
      apiErrorCode: null,
      apiErrorMessage: null,
    } as any),
  );

  return { operator, customer, order, mapping, initialBalance, expectedSettleAmount };
}

function buildUser(emailPrefix: string, authority: IUserAuthority, balance: number): Partial<UserEntity> {
  return {
    companyId: null,
    settlementCode: '',
    departmentId: null,
    email: `${emailPrefix}@example.com`,
    password: 'password',
    isPasswordReset: false,
    passwordChangedAt: null,
    authority,
    status: IUserStatus.USED,
    personName: emailPrefix,
    personPhoneNumber: '01000000000',
    personEmail: `${emailPrefix}@example.com`,
    personCode: emailPrefix,
    businessType: null,
    corporateNumber: '',
    isHeadPerson: false,
    ip: null,
    settleCondition: IUserSettleCondition.POST_PAYMENT,
    settleMethod: IUserSettleMethod.CASH,
    bankName: '',
    bankNumber: '',
    cardName: '',
    cardNumber: '',
    balance,
    fromPhoneNumber: null,
    settlePeriodCondition: null,
    settlePeriodCount: null,
    allSettleAmount: 0,
    serviceAmount: 0,
    duplicatePhoneLimit: 0,
    authorityList: null,
    apiKeyHash: null,
  };
}

function wrapFirstDeliverySaveWithDelay(repository: Repository<OrderDeliveryEntity>, delayMs: number) {
  let delayed = false;

  return {
    ...repository,
    save: jest.fn(async (entity: OrderDeliveryEntity) => {
      if (!delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return repository.save(entity);
    }),
  };
}
