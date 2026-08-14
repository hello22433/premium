import { PartnerSettleFeatureFlag } from '../../partner_settle/application/partner.settle.feature.flag';
import { PartnerSettleProducerService } from '../../partner_settle/application/partner.settle.producer.service';
// 실제 DB 연결 없는 단위 테스트이므로 typeorm-transactional 데코레이터를 no-op으로 mock한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  runInTransaction: (fn: () => Promise<unknown>) => fn(),
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
        { provide: PartnerSettleFeatureFlag, useValue: { isEnabled: false, isEnabledFor: () => false } },
        { provide: PartnerSettleProducerService, useValue: {} },
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
      // 상태 보정 — save(merge) 금지, targeted update 여야 한다 (D3-60 clobber)
      expect(orderDeliveryRepository.save).not.toHaveBeenCalled();
      expect(orderDeliveryRepository.update).toHaveBeenCalled();
      const [where, patch] = orderDeliveryRepository.update.mock.calls[0];
      expect(where).toEqual({ id: 3001 });
      // 이 분기가 바꾸는 3컬럼만. 더 실으면 안 바꾼 컬럼을 stale 스냅샷으로 덮는다.
      expect(Object.keys(patch).sort()).toEqual(['couponStatus', 'discardedAt', 'galaxiaBalance']);
      expect(patch.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);
      // discardedAt은 배치 실행 시각이 아니라 환불 이벤트 시각(appDay=20260520, appTime=120000)
      expect(patch.discardedAt).toBeInstanceOf(Date);
      expect(patch.discardedAt.getTime()).toBe(new Date(2026, 4, 20, 12, 0, 0).getTime());
      expect(patch.galaxiaBalance).toBe(0);
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

      const [, patch] = orderDeliveryRepository.update.mock.calls[0];
      expect(patch.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);
      expect(patch.discardedAt).toBe(existingDiscardedAt);
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
      const [, patch] = orderDeliveryRepository.update.mock.calls[0];
      expect(patch.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);
    });
  });

  describe('appDiv=10 (사용) 거래는 상태 보정 대상이 아니다', () => {
    it('사용처(appStore)가 없으면 couponStatus를 건드리지 않는다 (orderDelivery 쓰기 미호출)', async () => {
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
      expect(orderDeliveryRepository.update).not.toHaveBeenCalled();
    });
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// 잔존 데이터 복구 회귀 테스트 — existingLog + flag ON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 이전 결함 버전에서 "로그 저장 성공 → 원장 생성 실패" 로 고아 로그가 남은 케이스.
 * flag ON + existingLog 가 있으면 기존 log ID 기반 멱등키로 원장 생성을 재시도한다.
 *
 * 1) appDiv 10/20/25 — 사용 record / recordCancellation 재시도
 * 2) appDiv 81       — 상태 보정 + 역분개 재시도 (same-tx)
 */
describe('PartnerCompanyExternBatchService.checkGalaxiaDaily — existingLog 원장 복구 (flag ON)', () => {
  let sut: PartnerCompanyExternBatchService;
  let galaxia: { checkDaily: jest.Mock };
  let galaxiaBarcodeLogRepository: ReturnType<typeof makeRepoMock>;
  let orderDeliveryRepository: ReturnType<typeof makeRepoMock>;
  let settleProducer: {
    isSettlementTarget: jest.Mock;
    record: jest.Mock;
    recordCancellation: jest.Mock;
    findReversibleEntries: jest.Mock;
  };

  const EXISTING_LOG_ID = 7777;

  const buildTransaction = (overrides: Partial<any> = {}) => ({
    appDiv: '10',
    barcode: 'BC-9999',
    appDay: '20260520',
    appTime: '120000',
    amount: '50000',
    appNo: 'AP123',
    appStore: '',
    ...overrides,
  });

  /** relations 포함 — loadOrderDeliveryForSettlement 의 findOne 이 돌려줄 형상. */
  const buildOrderDeliveryWithRelations = (overrides: Partial<any> = {}): OrderDeliveryEntity =>
    ({
      id: 3001,
      barCode: 'BC-9999',
      discardedAt: null,
      choiceSelectProductId: null,
      choiceSelectProduct: null,
      orderProductMapping: {
        snapshotProductPrice: 50000,
        snapshotProductCategory: 'GIFT',
        snapshotProductClassificationId: 1,
        snapshotProductBrandName: 'TestBrand',
        snapshotProductExpireDay: 30,
        product: {
          settleMethod: 'PURCHASE',
          partnerCompanyId: 100,
          partnerCompany: { id: 100 },
          brand: { code: 'TB' },
        },
      },
      ...overrides,
    }) as unknown as OrderDeliveryEntity;

  const runDaily = () => (sut as any).processGalaxiaDailyByGiftKind('cpn', '20260520');

  beforeEach(async () => {
    jest.clearAllMocks();
    galaxia = { checkDaily: jest.fn() };

    settleProducer = {
      isSettlementTarget: jest.fn().mockReturnValue(true),
      record: jest.fn().mockResolvedValue(null),
      recordCancellation: jest.fn().mockResolvedValue(null),
      findReversibleEntries: jest.fn().mockResolvedValue([{ id: 501 }]),
    };

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
        { provide: PartnerSettleFeatureFlag, useValue: { isEnabled: true, isEnabledFor: () => true } },
        { provide: PartnerSettleProducerService, useValue: settleProducer },
      ],
    }).compile();

    sut = module.get<PartnerCompanyExternBatchService>(PartnerCompanyExternBatchService);
    galaxiaBarcodeLogRepository = module.get(getRepositoryToken(GalaxiaBarcodeLogEntity));
    orderDeliveryRepository = module.get(getRepositoryToken(OrderDeliveryEntity));

    // dedup 에서 기존 로그 발견 (existingLog)
    galaxiaBarcodeLogRepository.createQueryBuilder.mockReturnValue(makeQueryBuilderMock({ id: EXISTING_LOG_ID }));
    // loadOrderDeliveryForSettlement 용 — relations 포함
    orderDeliveryRepository.findOne.mockResolvedValue(buildOrderDeliveryWithRelations());
    orderDeliveryRepository.save.mockImplementation((entity: any) => Promise.resolve(entity));
  });

  describe('appDiv=10/20/25 기존 로그 — 원장 생성 재시도', () => {
    it.each(['10', '20', '25'])('appDiv=%s: existingLog.id 기반 멱등키로 원장을 재시도한다', async (appDiv) => {
      galaxia.checkDaily.mockResolvedValue({
        resCode: '0000',
        resMsg: 'Success',
        transactions: [buildTransaction({ appDiv })],
      });

      await runDaily();

      // 로그가 이미 있으므로 save 하지 않는다
      expect(galaxiaBarcodeLogRepository.save).not.toHaveBeenCalled();

      if (appDiv === '10') {
        // 사용 → record (양수 원장)
        expect(settleProducer.record).toHaveBeenCalledTimes(1);
        expect(settleProducer.record).toHaveBeenCalledWith(
          expect.objectContaining({ orderDeliveryId: 3001 }),
          expect.objectContaining({
            kind: 'USAGE',
            baseAmount: BigInt(50000),
            galaxiaBarcodeLogId: EXISTING_LOG_ID,
          }),
        );
      } else {
        // 20/25 → recordCancellation (역분개)
        expect(settleProducer.findReversibleEntries).toHaveBeenCalledWith(3001);
        expect(settleProducer.recordCancellation).toHaveBeenCalledTimes(1);
        expect(settleProducer.recordCancellation).toHaveBeenCalledWith(
          expect.objectContaining({ orderDeliveryId: 3001 }),
          expect.objectContaining({
            kind: 'USAGE',
            reversesLedgerId: 501,
            galaxiaBarcodeLogId: EXISTING_LOG_ID,
          }),
        );
      }
    });
  });

  describe('appDiv=81 기존 로그 — 상태 보정 + 역분개 재시도 (same-tx)', () => {
    it('existingLog.id 기반 멱등키로 역분개를 재시도하고 상태도 보정한다', async () => {
      galaxia.checkDaily.mockResolvedValue({
        resCode: '0000',
        resMsg: 'Success',
        transactions: [buildTransaction({ appDiv: '81' })],
      });

      await runDaily();

      // 로그가 이미 있으므로 save 하지 않는다
      expect(galaxiaBarcodeLogRepository.save).not.toHaveBeenCalled();

      // 상태 보정 — targeted update (save 아닌 update)
      expect(orderDeliveryRepository.save).not.toHaveBeenCalled();
      expect(orderDeliveryRepository.update).toHaveBeenCalled();
      const [where, patch] = orderDeliveryRepository.update.mock.calls[0];
      expect(where).toEqual({ id: 3001 });
      expect(patch.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);
      expect(patch.galaxiaBalance).toBe(0);

      // 역분개 재시도 — existingLog.id 기반
      expect(settleProducer.findReversibleEntries).toHaveBeenCalledWith(3001);
      expect(settleProducer.recordCancellation).toHaveBeenCalledTimes(1);
      expect(settleProducer.recordCancellation).toHaveBeenCalledWith(
        expect.objectContaining({ orderDeliveryId: 3001 }),
        expect.objectContaining({
          kind: 'USAGE',
          reversesLedgerId: 501,
          galaxiaBarcodeLogId: EXISTING_LOG_ID,
        }),
      );
    });

    it('역분개 대상 원본이 없으면(이미 전액 역분개) 원장 호출 없이 상태 보정만 한다', async () => {
      settleProducer.findReversibleEntries.mockResolvedValue([]);

      galaxia.checkDaily.mockResolvedValue({
        resCode: '0000',
        resMsg: 'Success',
        transactions: [buildTransaction({ appDiv: '81' })],
      });

      await runDaily();

      // 상태 보정은 수행
      expect(orderDeliveryRepository.update).toHaveBeenCalled();
      const [, patch] = orderDeliveryRepository.update.mock.calls[0];
      expect(patch.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);

      // 역분개 대상 없음 → recordCancellation 미호출
      expect(settleProducer.recordCancellation).not.toHaveBeenCalled();
    });
  });
});
