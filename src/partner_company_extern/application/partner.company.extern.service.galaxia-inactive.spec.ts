import { PartnerSettleFeatureFlag } from '../../partner_settle/application/partner.settle.feature.flag';
import { PartnerSettleProducerService } from '../../partner_settle/application/partner.settle.producer.service';
// 실제 DB 연결 없는 단위 테스트이므로 typeorm-transactional 데코레이터를 no-op으로 mock한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { SsgInsertStateService } from '../../delivery/application/ssg-insert-state.service';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { PartnerCompanyExternService } from './partner.company.extern.service';

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
  // refreshCouponStatus 의 영속은 optimistic CAS(QueryBuilder) 다 — coupon_status 가 진입 시점에서
  // 변하지 않았을 때만 쓴다(조회 중 폐기가 확정되면 stale 결과로 덮어쓰지 않기 위해).
  createQueryBuilder: jest.fn(() => {
    const qb: any = {
      update: jest.fn(() => qb),
      set: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    return qb;
  }),
});

/**
 * refreshCouponStatus GALAXIA 분기 — INACTIVE 응답 처리 검증.
 *
 * 갤럭시아 check API는 81 환불등록과 자연 만료를 모두 'INACTIVE'로 응답하므로,
 * galaxia_barcode_log 의 app_div='81' 기록 유무로 REFUND_CANCEL / EXPIRED 를 분기한다.
 * 본 spec은 그 분기 로직과 discardedAt 보존 동작을 단위 테스트로 고정한다.
 */
describe('PartnerCompanyExternService.refreshCouponStatus — GALAXIA INACTIVE 분기', () => {
  let sut: PartnerCompanyExternService;
  let galaxia: { issue: jest.Mock; check: jest.Mock; cancel: jest.Mock };
  let galaxiaBarcodeLogRepository: ReturnType<typeof makeRepoMock>;
  let orderDeliveryRepository: ReturnType<typeof makeRepoMock>;

  const mockCrypto = {
    safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000'),
  };

  const buildOrderDelivery = (overrides: Partial<any> = {}): OrderDeliveryEntity =>
    ({
      id: 2001,
      transactionId: 'ENM2D2001',
      couponNum: 'CN-9999',
      barCode: 'BC-9999',
      orderProductMapping: {
        product: {
          name: '테스트 상품',
          partnerCompany: { type: 'GALAXIA' },
        },
      },
      ...overrides,
    }) as unknown as OrderDeliveryEntity;

  const buildGiftCertificate = (overrides: Partial<any> = {}) => ({
    couponStatus: 'INACTIVE',
    isUsed: false,
    validTo: '99991231',
    usedDate: null,
    balance: 0,
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    galaxia = {
      issue: jest.fn(),
      check: jest.fn(),
      cancel: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerCompanyExternService,
        { provide: 'IGalaxia', useValue: galaxia },
        { provide: 'IGsmbiz', useValue: mock<any>() },
        { provide: 'IGiftiel', useValue: mock<any>() },
        { provide: 'IGiftiShow', useValue: mock<any>() },
        { provide: 'ICulture', useValue: mock<any>() },
        { provide: 'ISsgIssue', useValue: mock<any>() },
        { provide: 'IDaou', useValue: mock<any>() },
        {
          provide: getRepositoryToken(OrderDeliveryEntity),
          useValue: { ...mock<Repository<OrderDeliveryEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(PartnerCompanyExternHistoryEntity),
          useValue: { ...mock<Repository<PartnerCompanyExternHistoryEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(PartnerCompanyEntity),
          useValue: { ...mock<Repository<PartnerCompanyEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(PinIssueDedupEntity),
          useValue: { ...mock<Repository<PinIssueDedupEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(SsgIssueLogEntity),
          useValue: { ...mock<Repository<SsgIssueLogEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(SsgResendDeductPendingEntity),
          useValue: {},
        },
        { provide: PartnerSettleFeatureFlag, useValue: { isEnabled: false, isEnabledFor: () => false } },
        { provide: PartnerSettleProducerService, useValue: {} },
        {
          provide: getRepositoryToken(GiftielExchangeHistoryEntity),
          useValue: { ...mock<Repository<GiftielExchangeHistoryEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(GalaxiaBarcodeLogEntity),
          useValue: { ...mock<Repository<GalaxiaBarcodeLogEntity>>(), ...makeRepoMock() },
        },
        { provide: CryptoCipher, useValue: mockCrypto },
        {
          provide: SsgInsertStateService,
          useValue: {
            markAttempted: jest.fn(),
            markConfirmed: jest.fn(),
            markFailed: jest.fn(),
            getState: jest.fn(),
          },
        },
      ],
    }).compile();

    sut = module.get<PartnerCompanyExternService>(PartnerCompanyExternService);
    galaxiaBarcodeLogRepository = module.get(getRepositoryToken(GalaxiaBarcodeLogEntity));
    orderDeliveryRepository = module.get(getRepositoryToken(OrderDeliveryEntity));
    // refreshCouponStatus 마지막에 save 호출. save 가 entity 그대로 반환하도록 mock.
    orderDeliveryRepository.save.mockImplementation((entity: any) => Promise.resolve(entity));
  });

  // 유효기간이 지난(만료된) 쿠폰: validTo가 과거 → isExpiredYMD=true → stillValid=false.
  // 이 경우엔 81 로그 유무만으로 환불/만료를 가른다.
  const EXPIRED_VALID_TO = '20200101';

  describe('app_div=81 로그가 존재할 때 (= 81 환불 push 도착)', () => {
    it('유효기간이 지났어도 81 로그가 있으면 REFUND_CANCEL 로 매핑하고 discardedAt 을 새로 박는다', async () => {
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({ validTo: EXPIRED_VALID_TO }),
      });
      galaxiaBarcodeLogRepository.existsBy.mockResolvedValue(true);

      const result = await sut.refreshCouponStatus(orderDelivery);

      expect(galaxiaBarcodeLogRepository.existsBy).toHaveBeenCalledWith({
        orderDeliveryId: 2001,
        appDiv: '81',
      });
      expect(result.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);
      expect(result.discardedAt).toBeInstanceOf(Date);
    });

    it('이미 discardedAt 이 박혀 있으면 기존 시각을 보존한다 (push 81 → check 순서 방어)', async () => {
      const existingDiscardedAt = new Date('2026-05-15T10:00:00Z');
      const orderDelivery = buildOrderDelivery({ discardedAt: existingDiscardedAt });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({ validTo: EXPIRED_VALID_TO }),
      });
      galaxiaBarcodeLogRepository.existsBy.mockResolvedValue(true);

      const result = await sut.refreshCouponStatus(orderDelivery);

      expect(result.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);
      expect(result.discardedAt).toBe(existingDiscardedAt);
    });
  });

  describe('유효기간이 남았는데 INACTIVE 인 경우 (= push 누락 환불 보정, H1)', () => {
    it('81 로그가 없어도 유효기간 내면 REFUND_CANCEL 로 매핑한다 (자연 만료 불가능)', async () => {
      // validTo=99991231(기본) → 아직 유효기간 내. push 누락으로 81 로그는 없는 상태.
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      galaxia.check.mockResolvedValue({ giftCertificate: buildGiftCertificate() });
      galaxiaBarcodeLogRepository.existsBy.mockResolvedValue(false);

      const result = await sut.refreshCouponStatus(orderDelivery);

      expect(result.couponStatus).toBe(OrderDeliveryCouponStatus.REFUND_CANCEL);
      expect(result.discardedAt).toBeInstanceOf(Date);
    });
  });

  describe('유효기간이 지났고 81 로그도 없을 때 (= 자연 만료)', () => {
    it('INACTIVE → EXPIRED 로 매핑한다', async () => {
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({ validTo: EXPIRED_VALID_TO }),
      });
      galaxiaBarcodeLogRepository.existsBy.mockResolvedValue(false);

      const result = await sut.refreshCouponStatus(orderDelivery);

      expect(galaxiaBarcodeLogRepository.existsBy).toHaveBeenCalledWith({
        orderDeliveryId: 2001,
        appDiv: '81',
      });
      expect(result.couponStatus).toBe(OrderDeliveryCouponStatus.EXPIRED);
      expect(result.discardedAt).toBeNull();
    });
  });

  describe('INACTIVE 외 분기는 영향 없음', () => {
    it('CANCEL 응답은 기존대로 CANCEL 로 매핑하고 existsBy 를 호출하지 않는다', async () => {
      const orderDelivery = buildOrderDelivery({ discardedAt: null });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({ couponStatus: 'CANCEL' }),
      });

      const result = await sut.refreshCouponStatus(orderDelivery);

      expect(galaxiaBarcodeLogRepository.existsBy).not.toHaveBeenCalled();
      expect(result.couponStatus).toBe(OrderDeliveryCouponStatus.CANCEL);
      expect(result.discardedAt).toBeInstanceOf(Date);
    });

    it('isUsed 응답은 기존대로 USED 로 매핑한다', async () => {
      const orderDelivery = buildOrderDelivery();
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({ couponStatus: 'ACTIVE', isUsed: true }),
      });

      const result = await sut.refreshCouponStatus(orderDelivery);

      expect(galaxiaBarcodeLogRepository.existsBy).not.toHaveBeenCalled();
      expect(result.couponStatus).toBe(OrderDeliveryCouponStatus.USED);
    });
  });

  describe('잔액형 부분 사용/사용취소 — faceValue/balance 기반 교환 판정', () => {
    it('isUsed=false 여도 잔액이 줄었으면(부분 사용) USED 로 매핑하고 교환일시를 기록한다', async () => {
      const orderDelivery = buildOrderDelivery();
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({
          couponStatus: 'ACTIVE',
          isUsed: false,
          faceValue: '50000',
          balance: '30000', // 2만원 사용
          usedDate: '20260520',
        }),
      });

      const result = await sut.refreshCouponStatus(orderDelivery);

      expect(result.couponStatus).toBe(OrderDeliveryCouponStatus.USED);
      expect(result.galaxiaBalance).toBe(30000);
      expect(result.tradeAt).toBeInstanceOf(Date);
    });

    it('잔액이 전액 남으면(사용취소 등) NOT_USED 로 매핑하고 교환일시/장소를 비운다', async () => {
      const orderDelivery = buildOrderDelivery({
        tradeAt: new Date('2026-05-20T00:00:00Z'),
        tradePlace: '이전사용지점',
      });
      galaxia.check.mockResolvedValue({
        giftCertificate: buildGiftCertificate({
          couponStatus: 'ACTIVE',
          isUsed: false,
          faceValue: '50000',
          balance: '50000', // 전액 잔존
          usedDate: '20260520',
        }),
      });

      const result = await sut.refreshCouponStatus(orderDelivery);

      expect(result.couponStatus).toBe(OrderDeliveryCouponStatus.NOT_USED);
      expect(result.galaxiaBalance).toBe(50000);
      expect(result.tradeAt).toBeNull();
      expect(result.tradePlace).toBeNull();
    });
  });
});
