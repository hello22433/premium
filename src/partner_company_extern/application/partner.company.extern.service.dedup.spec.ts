import { PartnerSettleFeatureFlag } from '../../partner_settle/application/partner.settle.feature.flag';
import { PartnerSettleProducerService } from '../../partner_settle/application/partner.settle.producer.service';
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
  let resendDeductPendingRepository: any;
  let pendingQb: any;
  let orderDeliveryRepository: any;
  let ssgIssueLogRepository: any;

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

    pendingQb = {
      update: jest.fn(() => pendingQb),
      set: jest.fn(() => pendingQb),
      where: jest.fn(() => pendingQb),
      andWhere: jest.fn(() => pendingQb),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    resendDeductPendingRepository = { createQueryBuilder: jest.fn(() => pendingQb) };

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
          useValue: resendDeductPendingRepository,
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
    pinIssueDedupRepository = module.get(getRepositoryToken(PinIssueDedupEntity));
    orderDeliveryRepository = module.get(getRepositoryToken(OrderDeliveryEntity));
    ssgIssueLogRepository = module.get(getRepositoryToken(SsgIssueLogEntity));
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

  /**
   * ★ issue() 의 **모든 성공 반환 경로**가 PIN 을 order_delivery 에 durable 반영해야 한다
   *   (리뷰 CRITICAL, D3-60 후속).
   *
   * 종전에는 메인 경로(협력사 발급 완료 지점)에서만 update 했고, 조기 return 하는 경로들은
   * barCode 를 **메모리에만** 채운 뒤 caller 의 `save(orderDelivery)` 가 영속시켜 줬다.
   * D3-60 대응으로 그 save 들을 targeted update 로 바꾸면서 PIN 컬럼이 대상에서 빠졌고,
   * 조기 return 경로에서 `bar_code` 가 NULL 로 남는 결함이 생겼다.
   *
   * 결말:
   *  - 고객은 바코드를 받았는데(이미지·문자로 나감) 우리 DB 엔 없다 → CS 조회 불가
   *  - 재발송 시 !barCode → 새 PIN 재발급·재과금 (고객이 가진 것과 불일치)
   *  - cancelOrder/execDiscard 의 `if (barCode && partnerCompany)` 가드가 falsy →
   *    협력사 취소를 건너뛴 채 환불만 집행 → 협력사엔 살아있는 핀 + 환불 완료 = 자금 손실
   *
   * caller 의 save 에 기대면 안 된다. issue() 가 스스로 책임진다.
   */
  describe('PIN durable 반영 — 모든 반환 경로 (리뷰 CRITICAL)', () => {
    /** order_delivery 에 barCode 를 쓴 update 호출. */
    const pinWrite = () => orderDeliveryRepository.update.mock.calls.find((c: any[]) => c[1] && 'barCode' in c[1]);

    it('자체(SELF) 상품: 협력사 호출 없이 만든 바코드도 DB 에 남긴다', async () => {
      const orderDelivery = buildOrderDelivery({
        orderProductMapping: {
          product: { type: 'SELF', name: '자체상품', price: 1000, partnerCompany: { type: 'GALAXIA' } },
        },
      });

      await sut.issue(orderDelivery, null);

      expect(orderDelivery.barCode).toBeTruthy(); // 메모리엔 생성됐고
      const write = pinWrite();
      expect(write).toBeDefined(); // DB 에도 반드시 남아야 한다
      expect(write[0]).toEqual({ id: 1001 });
      expect(write[1].barCode).toBe(orderDelivery.barCode);
    });

    it('비SSG dedup 복구: 이어받은 바코드를 DB 에 남긴다 (진입 조건이 곧 DB NULL 이다)', async () => {
      const orderDelivery = buildOrderDelivery();
      pinIssueDedupRepository.insert.mockRejectedValueOnce(makeDuplicateKeyError());
      pinIssueDedupRepository.findOne.mockResolvedValue({
        transactionId: 'ENM1D1001',
        barCode: 'GX-BAR-9999',
      });
      // fresh?.barCode 가 없어야 이 폴백으로 온다 = DB order_delivery 에 PIN 이 없다는 뜻
      orderDeliveryRepository.findOne.mockResolvedValue({ id: 1001, barCode: null });

      await sut.issue(orderDelivery, null);

      expect(orderDelivery.barCode).toBe('GX-BAR-9999');
      const write = pinWrite();
      expect(write).toBeDefined();
      expect(write[1].barCode).toBe('GX-BAR-9999');
    });

    it('메인 경로(협력사 발급): 종전대로 DB 에 남긴다', async () => {
      const orderDelivery = buildOrderDelivery();
      galaxia.issue.mockResolvedValue({
        transactionId: 'galaxia-tr-1',
        giftCertificate: { barcode: 'GX-BAR-0001' },
      });

      await sut.issue(orderDelivery, null);

      expect(pinWrite()![1].barCode).toBe('GX-BAR-0001');
    });

    /**
     * ★ SSG dedup exact 복구 경로 — 네 번째(그리고 마지막) 조기 return.
     *
     * 이 분기의 **진입 조건 자체가** `fresh?.barCode` 부재, 즉 "DB order_delivery 에 PIN 이 없다"
     * 이다. 그래서 ssg_issue_log 에서 payload 를 복원하는데, 그 복원은 **메모리 엔티티에만**
     * 일어난다. persistIssuedPin 이 없으면 여기서 그대로 return 되고 bar_code 는 NULL 로 남는다.
     *
     * 그리고 이 경로는 SSG 다 — 외부 SSG 서버에는 핀이 INSERT 되어 있고 행사 잔액도 차감된 상태다.
     * 우리 DB 만 NULL 이면:
     *   - cancelOrder/execDiscard 의 `if (barCode && partnerCompany)` 가드가 falsy → 협력사 취소를
     *     건너뛴 채 환불만 집행 → SSG 엔 살아있는 핀 + 환불 완료 = 자금 손실
     *   - 재발송 시 !barCode → 새 PIN 재발급 + 새 행사 재차감
     *
     * 메모리 복원과 durable 반영은 별개다. 복원만 하고 끝내면 caller 의 targeted update 는
     * PIN 컬럼을 안 건드리므로(D3-60) 아무도 그 값을 쓰지 않는다.
     */
    const buildSsgDelivery = () =>
      buildOrderDelivery({
        orderProductMapping: {
          product: {
            type: 'COUPON',
            name: 'SSG 1만원',
            price: 10000,
            partnerCompanyCode: 'SSG-1',
            partnerCompany: { type: 'SSG' },
          },
        },
      });

    it('SSG dedup exact 복구: ssg_issue_log 에서 복원한 payload 전체를 DB 에 남긴다', async () => {
      const orderDelivery = buildSsgDelivery();
      pinIssueDedupRepository.insert.mockRejectedValueOnce(makeDuplicateKeyError());
      pinIssueDedupRepository.findOne.mockResolvedValue({
        transactionId: 'ENM1D1001',
        barCode: 'SSG-BAR-7777',
      });
      // fresh 에 barCode 가 없어야 이 분기로 온다 = DB order_delivery 는 아직 NULL
      orderDeliveryRepository.findOne.mockResolvedValue({ id: 1001, barCode: null });
      ssgIssueLogRepository.findOne.mockResolvedValue({
        id: 77,
        orderDeliveryId: 1001,
        barCode: 'SSG-BAR-7777',
        personalCode: 'SSG-PIN-7777',
        couponNum: 'CPN-7777',
        ssgTransactionId: 'ssg-tr-7777',
        expireAt: new Date('2026-08-14T00:00:00.000Z'),
        encourageAt: new Date('2026-08-07T00:00:00.000Z'),
        ssgEventId: 42,
      });

      const result = await sut.issue(orderDelivery, null);

      // dedup 이 가리키는 '정확한' 바코드의 로그로만 복원한다(최신 로그 auto-select 금지)
      expect(ssgIssueLogRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderDeliveryId: 1001, barCode: 'SSG-BAR-7777' } }),
      );
      expect(orderDelivery.barCode).toBe('SSG-BAR-7777'); // 메모리 복원은 됐고

      // ★ 여기가 핵심 — 메모리에만 있으면 아무 소용이 없다. DB 에 반드시 남아야 한다.
      const write = pinWrite();
      expect(write).toBeDefined();
      expect(write[0]).toEqual({ id: 1001 });
      // barCode 만 남기고 나머지를 흘리면 SSG 취소 API 가 personalCode/ssgTransactionId 없이 실패한다
      expect(write[1]).toMatchObject({
        barCode: 'SSG-BAR-7777',
        personalCode: 'SSG-PIN-7777',
        couponNum: 'CPN-7777',
        ssgTransactionId: 'ssg-tr-7777',
        expireAt: new Date('2026-08-14T00:00:00.000Z'),
        encourageAt: new Date('2026-08-07T00:00:00.000Z'),
        ssgEventId: 42, // 행사 귀속 — 누락 시 정산이 엉뚱한 행사로 잡힌다
      });
      expect(result.ssgEventId).toBe(42);
      expect(pinIssueDedupRepository.update).toHaveBeenCalledWith(
        { transactionId: 'ENM1D1001' },
        { recoveredFrom: 'DEDUP' },
      );
    });

    /**
     * exact 매칭이 없으면 fail-safe(ConflictException) 다 — 그리고 **아무것도 영속하지 않는다**.
     * 반쪽짜리 PIN(barCode 만, personalCode 없음)을 DB 에 박아 두면 다음 재시도의 fresh 경로가
     * "이미 복구됐다" 고 오판해 메타데이터 없는 핀이 그대로 굳는다.
     */
    it('SSG dedup exact 매칭 없음: ConflictException + PIN 을 절반만 남기지 않는다', async () => {
      const orderDelivery = buildSsgDelivery();
      pinIssueDedupRepository.insert.mockRejectedValueOnce(makeDuplicateKeyError());
      pinIssueDedupRepository.findOne.mockResolvedValue({
        transactionId: 'ENM1D1001',
        barCode: 'SSG-BAR-7777',
      });
      orderDeliveryRepository.findOne.mockResolvedValue({ id: 1001, barCode: null });
      ssgIssueLogRepository.findOne.mockResolvedValue(null); // 정확 매칭 없음

      await expect(sut.issue(orderDelivery, null)).rejects.toBeInstanceOf(ConflictException);

      expect(pinWrite()).toBeUndefined(); // 반쪽 PIN 영속 금지
      expect(pinIssueDedupRepository.update).not.toHaveBeenCalled(); // 복구표시도 하지 않는다(재시도 가능)
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

  describe('SSG dedup loser — 선차감 REUSED durable 마킹 순서(HIGH crash 안전)', () => {
    const buildSsgOrder = () =>
      buildOrderDelivery({
        orderProductMapping: {
          product: {
            type: 'COUPON',
            name: 'SSG 1만원',
            price: 10000,
            partnerCompanyCode: 'SSG-1',
            partnerCompany: { type: 'SSG' },
          },
        },
      });

    it('ER_DUP_ENTRY 즉시 + 다른 DB 조회(existing/fresh)보다 먼저 pending 을 REUSED 로 마킹한다', async () => {
      const ssgOrder = buildSsgOrder();
      pinIssueDedupRepository.insert.mockRejectedValueOnce(makeDuplicateKeyError());
      pinIssueDedupRepository.findOne.mockResolvedValue({ transactionId: 'ENM1D1001', barCode: 'WINNER-BAR' });
      orderDeliveryRepository.findOne.mockResolvedValue({
        id: 1001,
        barCode: 'WINNER-BAR',
        personalCode: 'p',
        ssgEventId: 50,
      });

      const result = await sut.issue(ssgOrder, null, 'rd-loser-1');

      expect(pendingQb.set).toHaveBeenCalledWith({ issueOutcome: 'REUSED' });
      expect(pendingQb.where).toHaveBeenCalledWith('resend_deduction_id = :rid', { rid: 'rd-loser-1' });
      // 마킹이 dedup existing/fresh 조회보다 먼저 실행됐다(marker-이전 crash window 제거).
      const markOrder = pendingQb.set.mock.invocationCallOrder[0];
      expect(markOrder).toBeLessThan(pinIssueDedupRepository.findOne.mock.invocationCallOrder[0]);
      expect(markOrder).toBeLessThan(orderDeliveryRepository.findOne.mock.invocationCallOrder[0]);
      expect(result.ssgNewIssue).toBe(false);
    });

    it('resendDeductionId 미전달 시 dedup loser 라도 REUSED 마킹 없음', async () => {
      const ssgOrder = buildSsgOrder();
      pinIssueDedupRepository.insert.mockRejectedValueOnce(makeDuplicateKeyError());
      pinIssueDedupRepository.findOne.mockResolvedValue({ transactionId: 'ENM1D1001', barCode: 'WINNER-BAR' });
      orderDeliveryRepository.findOne.mockResolvedValue({ id: 1001, barCode: 'WINNER-BAR', ssgEventId: 50 });

      await sut.issue(ssgOrder, null);

      expect(pendingQb.set).not.toHaveBeenCalled();
    });
  });
});
