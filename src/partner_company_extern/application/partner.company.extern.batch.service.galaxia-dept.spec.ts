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

/**
 * processGalaxiaDeptItem — dept 잔액배치의 INACTIVE/CANCEL 처리 검증 (감사 MEDIUM-3).
 *
 * dept 배치는 잔액 감소를 합성 사용로그(appDiv='10')로 저장하는데, 환불로 인한 잔액 감소까지
 * "사용"으로 오기록하면 안 된다. CANCEL/INACTIVE 응답이면 합성 로그 없이 상태만 정정해야 하고,
 * INACTIVE는 check() 분기와 동일하게 validTo·81 로그로 REFUND_CANCEL/EXPIRED를 구분한다.
 */
describe('PartnerCompanyExternBatchService.processGalaxiaDeptItem — INACTIVE/CANCEL 처리', () => {
  let sut: PartnerCompanyExternBatchService;
  let galaxia: { check: jest.Mock };
  let galaxiaBarcodeLogRepository: ReturnType<typeof makeRepoMock>;
  let orderDeliveryRepository: ReturnType<typeof makeRepoMock>;

  const buildOrderDelivery = (overrides: Partial<any> = {}): OrderDeliveryEntity =>
    ({
      id: 4001,
      barCode: 'BC-DEPT',
      couponNum: 'CN-DEPT',
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      galaxiaBalance: 0,
      discardedAt: null,
      tradeAt: null,
      choiceSelectProduct: null,
      orderProductMapping: { product: { name: '신세계상품권(백화점)', price: 50000 } },
      ...overrides,
    }) as unknown as OrderDeliveryEntity;

  const buildGiftCertificate = (overrides: Partial<any> = {}) => ({
    couponStatus: 'ACTIVE',
    isUsed: false,
    validTo: '99991231',
    usedDate: '',
    balance: '50000',
    ...overrides,
  });

  const runItem = (orderDelivery: OrderDeliveryEntity) => (sut as any).processGalaxiaDeptItem(orderDelivery);

  beforeEach(async () => {
    jest.clearAllMocks();
    galaxia = { check: jest.fn() };

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
  });

  describe('INACTIVE 응답 (환불/만료) — 합성 사용로그를 만들지 않는다', () => {
    it('유효기간 내 + 81 로그 없음 (push 누락 환불) → REFUND_CANCEL, 사용로그 미저장', async () => {
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({ couponStatus: 'INACTIVE', balance: '0', validTo: '99991231' }),
      });
      galaxiaBarcodeLogRepository.existsBy.mockResolvedValue(false);

      const result = await runItem(orderDelivery);

      expect(result).toBe('updated');
      expect(galaxiaBarcodeLogRepository.save).not.toHaveBeenCalled(); // 가짜 '10' 로그 없음
      expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
        { id: 4001 },
        expect.objectContaining({ couponStatus: OrderDeliveryCouponStatus.REFUND_CANCEL, galaxiaBalance: 0 }),
      );
      const updateData = orderDeliveryRepository.update.mock.calls[0][1];
      expect(updateData.discardedAt).toBeInstanceOf(Date);
    });

    it('유효기간 지남 + 81 로그 없음 → EXPIRED, 사용로그 미저장', async () => {
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({ couponStatus: 'INACTIVE', balance: '0', validTo: '20200101' }),
      });
      galaxiaBarcodeLogRepository.existsBy.mockResolvedValue(false);

      const result = await runItem(orderDelivery);

      expect(result).toBe('updated');
      expect(galaxiaBarcodeLogRepository.save).not.toHaveBeenCalled();
      expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
        { id: 4001 },
        expect.objectContaining({ couponStatus: OrderDeliveryCouponStatus.EXPIRED }),
      );
    });

    it('81 로그가 있으면 유효기간 지났어도 REFUND_CANCEL', async () => {
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({ couponStatus: 'INACTIVE', balance: '0', validTo: '20200101' }),
      });
      galaxiaBarcodeLogRepository.existsBy.mockResolvedValue(true);

      const result = await runItem(orderDelivery);

      expect(result).toBe('updated');
      expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
        { id: 4001 },
        expect.objectContaining({ couponStatus: OrderDeliveryCouponStatus.REFUND_CANCEL }),
      );
    });
  });

  describe('CANCEL 응답 — 합성 사용로그를 만들지 않는다', () => {
    it('CANCEL → CANCEL 상태, 사용로그 미저장', async () => {
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({ couponStatus: 'CANCEL', balance: '0' }),
      });

      const result = await runItem(orderDelivery);

      expect(result).toBe('updated');
      expect(galaxiaBarcodeLogRepository.existsBy).not.toHaveBeenCalled();
      expect(galaxiaBarcodeLogRepository.save).not.toHaveBeenCalled();
      expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
        { id: 4001 },
        expect.objectContaining({ couponStatus: OrderDeliveryCouponStatus.CANCEL }),
      );
    });
  });

  describe('정상 사용(ACTIVE) — 기존 사용 감지 로직 유지', () => {
    it('잔액 감소 시 합성 사용로그(appDiv=10) 저장 + USED', async () => {
      const orderDelivery = buildOrderDelivery({ couponStatus: OrderDeliveryCouponStatus.NOT_USED });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({
          couponStatus: 'ACTIVE',
          isUsed: true,
          balance: '30000', // 50000 → 30000, 2만원 사용
          usedDate: '20260520',
        }),
      });

      const result = await runItem(orderDelivery);

      expect(result).toBe('updated');
      expect(galaxiaBarcodeLogRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ orderDeliveryId: 4001, appDiv: '10', amount: 20000 }),
      );
      expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
        { id: 4001 },
        expect.objectContaining({ couponStatus: OrderDeliveryCouponStatus.USED, galaxiaBalance: 30000 }),
      );
    });

    it('잔액 변동 없으면 skip', async () => {
      const orderDelivery = buildOrderDelivery({ couponStatus: OrderDeliveryCouponStatus.NOT_USED });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({ couponStatus: 'ACTIVE', balance: '50000' }),
      });

      const result = await runItem(orderDelivery);

      expect(result).toBe('skipped');
      expect(galaxiaBarcodeLogRepository.save).not.toHaveBeenCalled();
      expect(orderDeliveryRepository.update).not.toHaveBeenCalled();
    });

    it('isUsed=false 여도 잔액이 줄었으면(부분 사용) USED 로 처리한다', async () => {
      const orderDelivery = buildOrderDelivery({ couponStatus: OrderDeliveryCouponStatus.NOT_USED });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({
          couponStatus: 'ACTIVE',
          isUsed: false, // 잔액형 부분 사용 시 갤럭시아가 false 로 내려주는 케이스
          balance: '30000', // 50000 → 30000, 2만원 사용
          usedDate: '20260520',
        }),
      });

      const result = await runItem(orderDelivery);

      expect(result).toBe('updated');
      expect(galaxiaBarcodeLogRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ orderDeliveryId: 4001, appDiv: '10', amount: 20000 }),
      );
      expect(orderDeliveryRepository.update).toHaveBeenCalledWith(
        { id: 4001 },
        expect.objectContaining({ couponStatus: OrderDeliveryCouponStatus.USED, galaxiaBalance: 30000 }),
      );
    });
  });
});
