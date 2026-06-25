// 실제 DB 연결 없는 단위 테스트이므로 typeorm-transactional 데코레이터를 no-op으로 mock한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyExternBatchService } from './partner.company.extern.batch.service';

const makeRepoMock = () => ({
  create: jest.fn(),
  save: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  softDelete: jest.fn(),
  count: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  existsBy: jest.fn(),
  query: jest.fn(),
  createQueryBuilder: jest.fn(),
});

// 매칭 조회(createQueryBuilder...getMany)용 체이너블 mock.
const makeQueryBuilderMock = (getManyResult: unknown[] = []) => {
  const qb: any = {
    select: jest.fn(() => qb),
    innerJoin: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    getMany: jest.fn().mockResolvedValue(getManyResult),
  };
  return qb;
};

/**
 * backfillCulturelandDailyRange — IP 차단(2026-01-01~)으로 누락된 일대사 사후 보정.
 * 일대사로 실제 사용된 certNo(+사용일)를 수집해, 60일 컬쳐랜드 발송건 중
 * NOT_USED/EXPIRED(만료로 잘못 찍힌 피해)를 USED(교환)+tradeAt(실제 사용일)로 정정한다.
 */
describe('PartnerCompanyExternBatchService.backfillCulturelandDailyRange', () => {
  let sut: PartnerCompanyExternBatchService;
  let culture: { checkDaily: jest.Mock };
  let orderDeliveryRepository: ReturnType<typeof makeRepoMock>;

  const useDate = '20260115';
  const matchedRows = () => [
    { id: 100, couponNum: 'CERT-EXP', couponStatus: OrderDeliveryCouponStatus.EXPIRED },
    { id: 101, couponNum: 'CERT-NU', couponStatus: OrderDeliveryCouponStatus.NOT_USED },
    { id: 102, couponNum: 'CERT-USED', couponStatus: OrderDeliveryCouponStatus.USED },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();
    culture = { checkDaily: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerCompanyExternBatchService,
        { provide: 'IGalaxia', useValue: mock<any>() },
        { provide: 'IGsmbiz', useValue: mock<any>() },
        { provide: 'IGiftiel', useValue: mock<any>() },
        { provide: 'IGiftiShow', useValue: mock<any>() },
        { provide: 'ICulture', useValue: culture },
        { provide: 'ISsgIssue', useValue: mock<any>() },
        { provide: 'IDaou', useValue: mock<any>() },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GalaxiaBarcodeLogEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GiftielExchangeHistoryEntity), useValue: makeRepoMock() },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('test'), get: jest.fn() } },
        { provide: CryptoCipher, useValue: mock<any>() },
      ],
    }).compile();

    sut = module.get<PartnerCompanyExternBatchService>(PartnerCompanyExternBatchService);
    orderDeliveryRepository = module.get(getRepositoryToken(OrderDeliveryEntity));

    culture.checkDaily.mockResolvedValue({
      memberCode: 'M',
      subMemberCode: 'S',
      useDate,
      certNoList: ['CERT-EXP', 'CERT-NU', 'CERT-USED'],
    });
  });

  it('드라이런(apply=false): DB 변경 없이 NOT_USED/EXPIRED만 보정 대상으로 집계하고 USED는 제외한다', async () => {
    orderDeliveryRepository.createQueryBuilder.mockReturnValue(makeQueryBuilderMock(matchedRows()));

    const result = await sut.backfillCulturelandDailyRange(useDate, useDate, false);

    expect(result.apply).toBe(false);
    expect(result.daysQueried).toBe(1);
    expect(result.matched).toBe(3);
    expect(result.skippedTerminal).toBe(1); // USED 1건 제외
    expect(result.fromStatus).toEqual({
      [OrderDeliveryCouponStatus.EXPIRED]: 1,
      [OrderDeliveryCouponStatus.NOT_USED]: 1,
    });
    // 드라이런이므로 update 미호출
    expect(orderDeliveryRepository.update).not.toHaveBeenCalled();
    expect(result.updated).toBe(0);
    // 실제 사용일이 tradeAt 으로 매핑됨
    const expSample = result.samples.find((s) => s.orderDeliveryId === 100);
    expect(expSample).toEqual(
      expect.objectContaining({
        certNo: 'CERT-EXP',
        fromStatus: OrderDeliveryCouponStatus.EXPIRED,
        useDate,
        tradeAt: '2026-01-15',
      }),
    );
  });

  it('apply=true: NOT_USED/EXPIRED를 USED+실제 사용일(tradeAt)로 update 하고 USED는 건드리지 않는다', async () => {
    orderDeliveryRepository.createQueryBuilder.mockReturnValue(makeQueryBuilderMock(matchedRows()));

    const result = await sut.backfillCulturelandDailyRange(useDate, useDate, true);

    expect(result.apply).toBe(true);
    expect(result.updated).toBe(2);
    expect(orderDeliveryRepository.update).toHaveBeenCalledTimes(2);

    const expectedTradeAt = new Date(2026, 0, 15);
    expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
      { id: 100 },
      { couponStatus: OrderDeliveryCouponStatus.USED, tradeAt: expectedTradeAt },
    );
    expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
      { id: 101 },
      { couponStatus: OrderDeliveryCouponStatus.USED, tradeAt: expectedTradeAt },
    );
    // USED(id 102)는 update 호출되지 않음
    expect(orderDeliveryRepository.update).not.toHaveBeenCalledWith({ id: 102 }, expect.anything());
  });

  it('일대사에 없는 certNo(매칭 없음)는 보정하지 않는다', async () => {
    // 우리 DB엔 일대사에 없는 다른 certNo만 존재 → getMany 빈 배열
    orderDeliveryRepository.createQueryBuilder.mockReturnValue(makeQueryBuilderMock([]));

    const result = await sut.backfillCulturelandDailyRange(useDate, useDate, true);

    expect(result.matched).toBe(0);
    expect(result.notFound).toBe(3);
    expect(result.updated).toBe(0);
    expect(orderDeliveryRepository.update).not.toHaveBeenCalled();
  });
});
