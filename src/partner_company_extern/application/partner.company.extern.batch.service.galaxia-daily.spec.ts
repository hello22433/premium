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

// 일대사 dedup 쿼리(createQueryBuilder...getOne)용 체이너블 mock.
const makeQueryBuilderMock = (getOneResult: unknown = null) => {
  const qb: any = {
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    getOne: jest.fn().mockResolvedValue(getOneResult),
  };
  return qb;
};

/**
 * checkGalaxiaDaily(processGalaxiaDailyByGiftKind) — 81(환불등록) 거래 상태 보정 검증.
 *
 * check 응답은 거래구분을 주지 않으므로(INACTIVE만), push가 유실되면 daily가 81을
 * 알려주는 유일한 채널이 된다. daily가 appDiv='81' 거래를 내려주면 로그 저장에 그치지 않고
 * couponStatus를 REFUND_CANCEL로 즉시 보정해야 한다(H1 사각지대: 만료 후 환불 + push 유실).
 */
describe('PartnerCompanyExternBatchService.checkGalaxiaDaily — 81 환불 상태 보정', () => {
  let sut: PartnerCompanyExternBatchService;
  let galaxia: { checkDaily: jest.Mock };
  let galaxiaBarcodeLogRepository: ReturnType<typeof makeRepoMock>;
  let orderDeliveryRepository: ReturnType<typeof makeRepoMock>;

  const buildTransaction = (overrides: Partial<any> = {}) => ({
    appDiv: '81',
    barcode: 'BC-9999',
    appDay: '20260520',
    appTime: '120000',
    amount: '50000',
    appNo: 'AP123',
    appStore: '',
    ...overrides,
  });

  const buildOrderDelivery = (overrides: Partial<any> = {}): OrderDeliveryEntity =>
    ({
      id: 3001,
      barCode: 'BC-9999',
      discardedAt: null,
      ...overrides,
    }) as unknown as OrderDeliveryEntity;

  const runDaily = () => (sut as any).processGalaxiaDailyByGiftKind('cpn', '20260520');

  beforeEach(async () => {
    jest.clearAllMocks();
    galaxia = { checkDaily: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerCompanyExternBatchService,
        { provide: 'IGalaxia', useValue: galaxia },
        { provide: 'IGsmbiz', useValue: mock<any>() },
        { provide: 'IGiftiel', useValue: mock<any>() },
        { provide: 'IGiftiShow', useValue: mock<any>() },
        { provide: 'ICulture', useValue: mock<any>() },
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
    galaxiaBarcodeLogRepository = module.get(getRepositoryToken(GalaxiaBarcodeLogEntity));
    orderDeliveryRepository = module.get(getRepositoryToken(OrderDeliveryEntity));

    // 기본값: dedup 결과 없음(신규 로그), save는 entity 그대로 반환
    galaxiaBarcodeLogRepository.createQueryBuilder.mockReturnValue(makeQueryBuilderMock(null));
    orderDeliveryRepository.save.mockImplementation((entity: any) => Promise.resolve(entity));
  });

  describe('appDiv=81 (환불등록) 거래', () => {
    it('로그 저장 + couponStatus를 REFUND_CANCEL로 보정하고 discardedAt을 새로 박는다', async () => {
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      orderDeliveryRepository.findOne.mockResolvedValue(orderDelivery);
      galaxia.checkDaily.mockResolvedValue({
        resCode: '0000',
        resMsg: 'Success',
        transactions: [buildTransaction({ appDiv: '81' })],
      });

      await runDaily();

      // 사용내역(로그) 저장 (신규)
      expect(galaxiaBarcodeLogRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ orderDeliveryId: 3001, appDiv: '81' }),
      );
      // 상태 보정
      expect(orderDeliveryRepository.save).toHaveBeenCalled();
      const saved = orderDeliveryRepository.save.mock.calls[0][0];
      expect(saved.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);
      // discardedAt은 배치 실행 시각이 아니라 환불 이벤트 시각(appDay=20260520, appTime=120000)
      expect(saved.discardedAt).toBeInstanceOf(Date);
      expect(saved.discardedAt.getTime()).toBe(new Date(2026, 4, 20, 12, 0, 0).getTime());
      expect(saved.galaxiaBalance).toBe(0);
    });

    it('이미 discardedAt이 박혀 있으면 기존 시각을 보존한다 (push 81 → daily 순서 방어)', async () => {
      const existingDiscardedAt = new Date('2026-05-15T10:00:00Z');
      const orderDelivery = buildOrderDelivery({ discardedAt: existingDiscardedAt });
      orderDeliveryRepository.findOne.mockResolvedValue(orderDelivery);
      galaxia.checkDaily.mockResolvedValue({
        resCode: '0000',
        resMsg: 'Success',
        transactions: [buildTransaction({ appDiv: '81' })],
      });

      await runDaily();

      const saved = orderDeliveryRepository.save.mock.calls[0][0];
      expect(saved.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);
      expect(saved.discardedAt).toBe(existingDiscardedAt);
    });

    it('로그가 이미 존재해도(중복) 상태 보정은 멱등하게 수행한다', async () => {
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      orderDeliveryRepository.findOne.mockResolvedValue(orderDelivery);
      // dedup에서 기존 로그 발견 → 로그 save는 건너뜀
      galaxiaBarcodeLogRepository.createQueryBuilder.mockReturnValue(makeQueryBuilderMock({ id: 1 }));
      galaxia.checkDaily.mockResolvedValue({
        resCode: '0000',
        resMsg: 'Success',
        transactions: [buildTransaction({ appDiv: '81' })],
      });

      await runDaily();

      expect(galaxiaBarcodeLogRepository.save).not.toHaveBeenCalled();
      const saved = orderDeliveryRepository.save.mock.calls[0][0];
      expect(saved.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);
    });
  });

  describe('appDiv=10 (사용) 거래는 상태 보정 대상이 아니다', () => {
    it('사용처(appStore)가 없으면 couponStatus를 건드리지 않는다 (orderDelivery save 미호출)', async () => {
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      orderDeliveryRepository.findOne.mockResolvedValue(orderDelivery);
      galaxia.checkDaily.mockResolvedValue({
        resCode: '0000',
        resMsg: 'Success',
        transactions: [buildTransaction({ appDiv: '10', appStore: '' })],
      });

      await runDaily();

      // 로그는 저장하지만 상태/orderDelivery는 저장하지 않음
      expect(galaxiaBarcodeLogRepository.save).toHaveBeenCalled();
      expect(orderDeliveryRepository.save).not.toHaveBeenCalled();
    });
  });
});
