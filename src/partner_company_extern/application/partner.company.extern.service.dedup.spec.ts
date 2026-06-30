// 실제 DB 연결 없는 단위 테스트이므로 typeorm-transactional 데코레이터를 no-op으로 mock한다.
// 이렇게 하면 @Transactional이 wrap-in-transaction을 거치지 않고 원래 메서드를 그대로 실행한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { QueryFailedError, Repository } from 'typeorm';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { SsgInsertStateService } from '../../delivery/application/ssg-insert-state.service';
import { PartnerCompanyExternService } from './partner.company.extern.service';

// 공유 헬퍼(createMockRepositoryMethod)는 jest.fn() 인스턴스를 repo 간에 공유시키므로,
// 본 spec에서는 각 repository에 isolated mock을 직접 만든다.
const makeRepoMock = () => ({
  create: jest.fn(),
  save: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  softDelete: jest.fn(),
  count: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  query: jest.fn(),
});

/**
 * PIN 발급 dedup + 인라인 recovery 로직 검증
 *
 * 테스트 범위: issue() 진입점의 dedup INSERT / conflict recovery / fallback 경로.
 * 협력사 API 실제 호출 흐름은 다른 경로에서 커버되므로, 본 spec은 recovery 로직 자체에 집중한다.
 */
describe('PartnerCompanyExternService - PIN dedup recovery', () => {
  let sut: PartnerCompanyExternService;
  let pinIssueDedupRepository: any;
  let galaxia: any;

  const mockCrypto = {
    safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000'),
  };

  const buildOrderDelivery = (overrides: Partial<any> = {}): OrderDeliveryEntity =>
    ({
      id: 1001,
      transactionId: 'ENM1D1001',
      deliveryTarget: 'encrypted-target',
      barCode: null,
      couponNum: null,
      orderProductMapping: {
        product: {
          type: 'COUPON',
          name: '테스트 상품',
          price: 5000,
          partnerCompanyCode: 'TEST-001',
          partnerCompany: { type: 'GALAXIA' },
        },
      },
      ...overrides,
    }) as unknown as OrderDeliveryEntity;

  const makeDuplicateKeyError = (): QueryFailedError => {
    const err = new QueryFailedError('INSERT', [], new Error('ER_DUP_ENTRY'));
    (err as unknown as { code: string }).code = 'ER_DUP_ENTRY';
    return err;
  };

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
    pinIssueDedupRepository = module.get(getRepositoryToken(PinIssueDedupEntity));
  });

  describe('정상 발송 경로', () => {
    it('dedup INSERT가 recoveredFrom=FRESH_ISSUE로 수행되고 협력사 발급 후 bar_code가 UPDATE된다', async () => {
      const orderDelivery = buildOrderDelivery();
      galaxia.issue.mockResolvedValue({
        transactionId: 'galaxia-tr-1',
        giftCertificate: { barcode: 'GX-BAR-0001' },
      });

      await sut.issue(orderDelivery, null);

      expect(pinIssueDedupRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'ENM1D1001',
          orderDeliveryId: 1001,
          partnerType: 'GALAXIA',
          recoveredFrom: 'FRESH_ISSUE',
        }),
      );
      expect(galaxia.issue).toHaveBeenCalledTimes(1);
      expect(orderDelivery.barCode).toBe('GX-BAR-0001');
      expect(pinIssueDedupRepository.update).toHaveBeenCalledWith(
        { transactionId: 'ENM1D1001' },
        { barCode: 'GX-BAR-0001' },
      );
    });
  });

  describe('동시 경쟁 recovery 경로', () => {
    it('ER_DUP_ENTRY 발생 시 기존 dedup row의 bar_code를 이어받고 협력사 호출을 생략한다', async () => {
      const orderDelivery = buildOrderDelivery();
      pinIssueDedupRepository.insert.mockRejectedValueOnce(makeDuplicateKeyError());
      pinIssueDedupRepository.findOne.mockResolvedValue({
        transactionId: 'ENM1D1001',
        orderDeliveryId: 1001,
        partnerType: 'GALAXIA',
        barCode: 'GX-BAR-9999',
        recoveredFrom: 'FRESH_ISSUE',
        issuedAt: new Date(),
      });

      await sut.issue(orderDelivery, null);

      expect(orderDelivery.barCode).toBe('GX-BAR-9999');
      expect(galaxia.issue).not.toHaveBeenCalled();
      expect(pinIssueDedupRepository.update).toHaveBeenCalledWith(
        { transactionId: 'ENM1D1001' },
        { recoveredFrom: 'DEDUP' },
      );
    });
  });

  describe('Recovery fallback 안전 가드', () => {
    it('ER_DUP_ENTRY 발생했지만 기존 row의 bar_code가 없으면 ConflictException을 throw한다', async () => {
      const orderDelivery = buildOrderDelivery();
      pinIssueDedupRepository.insert.mockRejectedValueOnce(makeDuplicateKeyError());
      pinIssueDedupRepository.findOne.mockResolvedValue({
        transactionId: 'ENM1D1001',
        orderDeliveryId: 1001,
        partnerType: 'GALAXIA',
        barCode: null,
        recoveredFrom: 'FRESH_ISSUE',
        issuedAt: new Date(),
      });

      await expect(sut.issue(orderDelivery, null)).rejects.toBeInstanceOf(ConflictException);
      expect(galaxia.issue).not.toHaveBeenCalled();
    });

    it('ER_DUP_ENTRY 발생했지만 findOne이 null을 반환하면 ConflictException을 throw한다', async () => {
      const orderDelivery = buildOrderDelivery();
      pinIssueDedupRepository.insert.mockRejectedValueOnce(makeDuplicateKeyError());
      pinIssueDedupRepository.findOne.mockResolvedValue(null);

      await expect(sut.issue(orderDelivery, null)).rejects.toBeInstanceOf(ConflictException);
      expect(galaxia.issue).not.toHaveBeenCalled();
    });
  });

  describe('CULTURELAND 포함', () => {
    it('CULTURELAND 발송도 dedup INSERT를 수행한다 (모든 협력사 동일 로직)', async () => {
      const orderDelivery = buildOrderDelivery({
        orderProductMapping: {
          product: {
            type: 'COUPON',
            name: '컬쳐랜드 5천원',
            price: 5000,
            expireDay: 30,
            partnerCompanyCode: 'CL-001',
            partnerCompany: { type: 'CULTURELAND' },
          },
        },
      });
      // culture.issue가 정의되지 않은 mock이라 이후 단계에서 throw됨.
      // 본 테스트는 CULTURELAND에 대해서도 dedup INSERT가 호출되는지만 검증한다.
      try {
        await sut.issue(orderDelivery, null);
      } catch {
        // culture mock이 미정의라 이후 단계에서 에러 가능 — INSERT 호출 여부만 검증
      }

      expect(pinIssueDedupRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'ENM1D1001',
          orderDeliveryId: 1001,
          partnerType: 'CULTURELAND',
          recoveredFrom: 'FRESH_ISSUE',
        }),
      );
    });
  });
});
