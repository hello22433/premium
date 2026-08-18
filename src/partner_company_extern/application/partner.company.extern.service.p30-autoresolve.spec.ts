import { PartnerSettleFeatureFlag } from '../../partner_settle/application/partner.settle.feature.flag';
import { PartnerSettleProducerService } from '../../partner_settle/application/partner.settle.producer.service';
import { SsgAutoResolveConfig } from './ssg.autoresolve.config';
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
import { IsNull, Repository } from 'typeorm';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { SsgInsertStateService } from '../../delivery/application/ssg-insert-state.service';
import { MarkAttemptedResult } from '../../delivery/interface/ssg.insert.state';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { SsgAutoResolveBlockedError, SsgTryError } from '../infra/ssg.issue';
import { SsgPinResolution } from '../interface/ssg.issue';
import { SSG_AUTORESOLVE_PHASE } from '../domain/ssg.autoresolve.policy';
import { PartnerCompanyExternService } from './partner.company.extern.service';

/**
 * EP-P30 P0 — 판정 레이어 + action consumer 잠금.
 *
 * 검증 축:
 *  1. 판정값 분리 — `tryYn='N'`(NOT_ISSUED) / 조회 실패(LOOKUP_FAILED) / 등록됐으나 사용불가
 *     (REGISTERED_UNSENDABLE) 가 더 이상 `UNKNOWN` 하나로 뭉개지지 않는다 (§5-2)
 *  2. 시도 이력 vs 활성 후보 — tombstone 된 발송건이 NOT_ATTEMPTED 로 오판되지 않는다 (§5-3-1)
 *  3. 판정 순수성 — CONFIRMED 라도 판정 단계에서는 durable 쓰기·메모리 변경 0회 (§6-B-2)
 *  4. action consumer 잠금 — 게이트가 닫힌 채 NOT_ISSUED 가 나와도 신규 INSERT 경로가 열리지 않고,
 *     `needsInsert=false` 재사용 분기로 새지 않는다 (§6-B-3, §6-B-3-1)
 */
describe('PartnerCompanyExternService — EP-P30 판정 레이어 (P0)', () => {
  let sut: PartnerCompanyExternService;
  let ssgIssue: { check: jest.Mock; issue: jest.Mock; generateSsgIssue: jest.Mock; getTry: jest.Mock };
  let ssgIssueLogRepository: jest.Mocked<Repository<SsgIssueLogEntity>>;
  let ssgInsertStateService: {
    getState: jest.Mock;
    markAttempted: jest.Mock;
    markConfirmed: jest.Mock;
    markFailed: jest.Mock;
    restoreConfirmedPinFromIssueLog: jest.Mock;
  };
  let pinIssueCommandRepository: { findOne: jest.Mock };
  let autoResolveMode: string;

  const activeAuthority = {
    commandId: 'command-1',
    ownerToken: 'owner-1',
    generation: '1',
    workflowVersion: '1',
  } as any;

  const tryOut = (tryYn: 'Y' | 'N') => ({
    response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ vno: ['x'], tryYn: [tryYn] }] },
  });
  const checkOut = (resultCd: string) => ({
    response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ resultCd: [resultCd] }] },
  });

  const makeRepoMock = () => ({
    create: jest.fn(),
    save: jest.fn(),
    insert: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    softDelete: jest.fn(),
    count: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
  });

  const buildSsgEvent = (): SsgEventEntity =>
    ({ id: 42, code: 'EK1', no: 'EV1', order: 1, eventPrice: 1000000, eventBalance: 1000000 }) as SsgEventEntity;

  const buildOrderDelivery = (overrides: Partial<any> = {}): OrderDeliveryEntity =>
    ({
      id: 9001,
      transactionId: 'ENM-SSG-9001',
      deliveryTarget: 'encrypted-target',
      barCode: null,
      personalCode: null,
      ssgTransactionId: null,
      couponNum: null,
      expireAt: null,
      encourageAt: null,
      orderProductMapping: {
        sendContent: 'hello',
        sendTailText: '',
        fromPhoneNumber: null,
        encourageDay: null,
        product: {
          type: 'COUPON',
          name: 'SSG',
          price: 5000,
          expireDay: 30,
          partnerCompanyCode: 'TEST-SSG',
          partnerCompany: { type: 'SSG' },
        },
      },
      ...overrides,
    }) as unknown as OrderDeliveryEntity;

  const buildCandidate = (overrides: Partial<any> = {}): SsgIssueLogEntity =>
    ({
      id: 1,
      orderDeliveryId: 9001,
      barCode: '8EXIST01',
      personalCode: '01300001234',
      ssgTransactionId: 'TR-EXIST',
      eventNo: 'EV1',
      eventSeq: 1,
      ssgEventId: 42,
      couponNum: null,
      insertedAt: new Date(),
      expireAt: new Date(),
      encourageAt: null,
      supersededAt: null,
      pinIssueCommandId: null,
      issueOrdinal: null,
      ...overrides,
    }) as unknown as SsgIssueLogEntity;

  beforeEach(async () => {
    jest.clearAllMocks();
    autoResolveMode = 'off';
    ssgIssue = {
      check: jest.fn(),
      issue: jest.fn().mockResolvedValue({ response: { result: [{ code: ['1000'], reason: ['ok'] }] } }),
      generateSsgIssue: jest.fn().mockReturnValue({ barCode: '80000001', personalCode: '01312345678' }),
      getTry: jest.fn().mockResolvedValue(tryOut('N')),
    };
    ssgIssueLogRepository = { ...mock<Repository<SsgIssueLogEntity>>(), ...makeRepoMock() } as unknown as jest.Mocked<
      Repository<SsgIssueLogEntity>
    >;
    pinIssueCommandRepository = {
      findOne: jest.fn().mockResolvedValue({ status: 'STARTED', externalIssueCount: 1, autoresolveVersion: null }),
    };
    ssgInsertStateService = {
      getState: jest.fn(),
      markAttempted: jest.fn().mockResolvedValue(MarkAttemptedResult.TRANSITIONED),
      markConfirmed: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(true),
      restoreConfirmedPinFromIssueLog: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerCompanyExternService,
        { provide: 'IGalaxia', useValue: mock<any>() },
        { provide: 'IGsmbiz', useValue: mock<any>() },
        { provide: 'IGiftiel', useValue: mock<any>() },
        { provide: 'IGiftiShow', useValue: mock<any>() },
        { provide: 'ICulture', useValue: mock<any>() },
        { provide: 'ISsgIssue', useValue: ssgIssue },
        { provide: 'IDaou', useValue: mock<any>() },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PartnerCompanyExternHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PartnerCompanyEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PinIssueDedupEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(SsgIssueLogEntity), useValue: ssgIssueLogRepository },
        { provide: getRepositoryToken(PinIssueCommandEntity), useValue: pinIssueCommandRepository },
        { provide: getRepositoryToken(GiftielExchangeHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GalaxiaBarcodeLogEntity), useValue: makeRepoMock() },
        { provide: CryptoCipher, useValue: { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000') } },
        { provide: SsgInsertStateService, useValue: ssgInsertStateService },
        {
          provide: getRepositoryToken(SsgResendDeductPendingEntity),
          useValue: { createQueryBuilder: jest.fn(() => ({ update: jest.fn().mockReturnThis() })) },
        },
        { provide: PartnerSettleFeatureFlag, useValue: { isEnabled: false, hasAnyActiveProvider: false, isEnabledFor: () => false } },
        { provide: PartnerSettleProducerService, useValue: {} },
        {
          provide: SsgAutoResolveConfig,
          useValue: new SsgAutoResolveConfig({ get: () => autoResolveMode } as any),
        },
      ],
    }).compile();

    sut = module.get(PartnerCompanyExternService);
  });

  describe('판정값 분리 (§5-2)', () => {
    it("tryYn='N' 은 UNKNOWN 이 아니라 NOT_ISSUED 다 — check 호출 없이 확정", async () => {
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockResolvedValue(tryOut('N'));

      const result = await sut.classifyDeferredSsgIssue(9001);

      expect(result.resolution).toBe(SsgPinResolution.NOT_ISSUED);
      expect(ssgIssue.check).not.toHaveBeenCalled();
    });

    it('조회 실패(SsgTryError)는 부재 증거가 아니라 LOOKUP_FAILED 다', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockRejectedValue(new SsgTryError('네트워크'));

      const result = await sut.classifyDeferredSsgIssue(9001);

      expect(result.resolution).toBe(SsgPinResolution.LOOKUP_FAILED);
    });

    it("tryYn='Y' + 비허용 resultCd(0103) → REGISTERED_UNSENDABLE 가 집계에서 소실되지 않는다", async () => {
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
      ssgIssue.check.mockResolvedValue(checkOut('0103'));

      const result = await sut.classifyDeferredSsgIssue(9001);

      expect(result.resolution).toBe(SsgPinResolution.REGISTERED_UNSENDABLE);
    });

    it('check 실패는 재발급 금지 상태를 유지한 채 LOOKUP_FAILED (재조회 대상)', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
      ssgIssue.check.mockRejectedValue(new Error('timeout'));

      const result = await sut.classifyDeferredSsgIssue(9001);

      expect(result.resolution).toBe(SsgPinResolution.LOOKUP_FAILED);
    });

    it('CONFIRMED 1건 + LOOKUP_FAILED 혼재 → 재사용하지 않고 LOOKUP_FAILED', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([
        buildCandidate({ id: 1, personalCode: '01300001111' }),
        buildCandidate({ id: 2, personalCode: '01300002222' }),
      ]);
      ssgIssue.getTry.mockImplementation(async ({ vno }: { vno: string }) =>
        vno === '01300001111' ? tryOut('Y') : Promise.reject(new SsgTryError('네트워크')),
      );
      ssgIssue.check.mockResolvedValue(checkOut('0100'));

      const result = await sut.classifyDeferredSsgIssue(9001);

      expect(result.resolution).toBe(SsgPinResolution.LOOKUP_FAILED);
      expect(result.confirmedCandidate).toBeUndefined();
    });
  });

  describe('시도 이력 vs 활성 후보 (§5-3-1)', () => {
    it('로그 0행 → NOT_ATTEMPTED. SSG 조회 0회', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([]);

      const result = await sut.classifyDeferredSsgIssue(9001);

      expect(result).toMatchObject({
        resolution: SsgPinResolution.NOT_ATTEMPTED,
        hasAnyAttempt: false,
        activeCandidateCount: 0,
      });
      expect(ssgIssue.getTry).not.toHaveBeenCalled();
    });

    it('tombstone 행만 있는 발송건은 NOT_ATTEMPTED 가 아니다 (ordinal=1 재발급 오판 차단)', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate({ supersededAt: new Date() })]);

      const result = await sut.classifyDeferredSsgIssue(9001);

      expect(result.resolution).toBe(SsgPinResolution.UNKNOWN);
      expect(result.hasAnyAttempt).toBe(true);
      expect(result.activeCandidateCount).toBe(0);
      expect(ssgIssue.getTry).not.toHaveBeenCalled();
    });

    it('tombstone 후보는 판정 대상에서 빠지고 활성 후보만 조회된다', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([
        buildCandidate({ id: 1, personalCode: '01300001111', supersededAt: new Date() }),
        buildCandidate({ id: 2, personalCode: '01300002222' }),
      ]);
      ssgIssue.getTry.mockResolvedValue(tryOut('N'));

      await sut.classifyDeferredSsgIssue(9001);

      expect(ssgIssue.getTry).toHaveBeenCalledTimes(1);
      expect(ssgIssue.getTry).toHaveBeenCalledWith({ vno: '01300002222' });
    });
  });

  describe('판정 순수성 (§6-B-2)', () => {
    it('CONFIRMED 가 나와도 판정 단계에서는 markConfirmed 0회 + 메모리 entity 미변경', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
      ssgIssue.check.mockResolvedValue(checkOut('0100'));
      const delivery = buildOrderDelivery();

      const result = await sut.classifyDeferredSsgIssue(delivery.id);

      expect(result.resolution).toBe(SsgPinResolution.CONFIRMED);
      expect(result.confirmedCandidate?.barCode).toBe('8EXIST01');
      expect(ssgInsertStateService.markConfirmed).not.toHaveBeenCalled();
      expect(delivery.barCode).toBeNull();
      expect(delivery.personalCode).toBeNull();
    });

    it('applyConfirmedCandidate 를 부른 뒤에야 PIN 이 복원된다', async () => {
      const delivery = buildOrderDelivery();

      await sut.applyConfirmedCandidate(delivery, buildCandidate());

      expect(delivery.barCode).toBe('8EXIST01');
      expect(ssgInsertStateService.markConfirmed).toHaveBeenCalledTimes(1);
    });
  });

  describe('action consumer 잠금 (§6-B-3 / §6-B-3-1)', () => {
    it("mode=off + tryYn='N' → issue() 는 정상 반환하지 않고 신규 INSERT·state 전이 0회", async () => {
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockResolvedValue(tryOut('N'));
      const delivery = buildOrderDelivery();

      await expect(sut.issue(delivery, buildSsgEvent(), undefined, activeAuthority, 1)).rejects.toBeInstanceOf(
        SsgAutoResolveBlockedError,
      );

      expect(ssgIssue.issue).not.toHaveBeenCalled();
      expect(ssgInsertStateService.markAttempted).not.toHaveBeenCalled();
      expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
      expect(delivery.barCode).toBeNull();
    });

    it("mode=observe + tryYn='N' 도 동일하게 잠긴다 (관측은 durable state 를 바꾸지 않는다)", async () => {
      autoResolveMode = 'observe';
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockResolvedValue(tryOut('N'));

      await expect(sut.issue(buildOrderDelivery(), buildSsgEvent(), undefined, activeAuthority, 1)).rejects.toBeInstanceOf(
        SsgAutoResolveBlockedError,
      );

      expect(ssgIssue.issue).not.toHaveBeenCalled();
      expect(ssgInsertStateService.markAttempted).not.toHaveBeenCalled();
    });

    it('후보 0건인 최초 발송(hot path)은 게이트와 무관하게 그대로 발급된다', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([]);
      const delivery = buildOrderDelivery();

      await sut.issue(delivery, buildSsgEvent(), undefined, activeAuthority, 1);

      expect(ssgIssue.issue).toHaveBeenCalledTimes(1);
      expect(delivery.barCode).toBe('80000001');
    });

    it('재발송 판정은 CONFIRMED 만 통과시키고 NOT_ISSUED 는 보류로 보낸다', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockResolvedValue(tryOut('N'));

      await expect(sut.classifySsgResendPin(9001, '01300001234')).rejects.toThrow(/NOT_ISSUED/);
    });

    it('재발송 판정의 후보 조회는 tombstone 을 제외한다', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
      ssgIssue.check.mockResolvedValue(checkOut('0100'));

      await sut.classifySsgResendPin(9001, '01300001234');

      expect(ssgIssueLogRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderDeliveryId: 9001, supersededAt: IsNull() } }),
      );
    });
  });

  /**
   * 재발급 권한은 count 1→2 로 **소비하기 전**에 게이트를 거친다. 따라서 count 로 차수를 추론하면
   * 재발급이 항상 ordinal=1 로 보이고, 1차만 열린 단계(P1)에서 2차 INSERT 가 그대로 통과한다.
   * P0 에서는 두 상수가 모두 false 라 이 결함이 드러나지 않으므로, P1 배포 상태를 직접 재현한다.
   */
  describe('차수 판정 (§6-B-3 · P1 배포 재현)', () => {
    const withPhase = async (phase: { ordinal1: boolean; ordinal2: boolean }, run: () => Promise<void>) => {
      const original = { ...SSG_AUTORESOLVE_PHASE };
      (SSG_AUTORESOLVE_PHASE as any).ORDINAL_1_INITIAL_ISSUE = phase.ordinal1;
      (SSG_AUTORESOLVE_PHASE as any).ORDINAL_2_REISSUE = phase.ordinal2;
      try {
        await run();
      } finally {
        Object.assign(SSG_AUTORESOLVE_PHASE as any, original);
      }
    };

    it('1차만 열린 단계 + count=1 NOT_ISSUED → 재발급은 여전히 차단된다', async () => {
      autoResolveMode = 'on';
      pinIssueCommandRepository.findOne.mockResolvedValue({
        status: 'STARTED',
        externalIssueCount: 1,
        autoresolveVersion: 1,
      });
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockResolvedValue(tryOut('N'));

      await withPhase({ ordinal1: true, ordinal2: false }, async () => {
        await expect(
          sut.issue(buildOrderDelivery(), buildSsgEvent(), undefined, activeAuthority, 1),
        ).rejects.toBeInstanceOf(SsgAutoResolveBlockedError);
      });

      expect(ssgIssue.issue).not.toHaveBeenCalled();
      expect(ssgInsertStateService.markAttempted).not.toHaveBeenCalled();
    });

    it('2차 상수를 뒤집어도 실행 증거(§5-4)가 없으면 재발급은 열리지 않는다', async () => {
      autoResolveMode = 'on';
      pinIssueCommandRepository.findOne.mockResolvedValue({
        status: 'STARTED',
        externalIssueCount: 1,
        autoresolveVersion: 1,
      });
      ssgIssueLogRepository.find.mockResolvedValue([buildCandidate()]);
      ssgIssue.getTry.mockResolvedValue(tryOut('N'));

      await withPhase({ ordinal1: false, ordinal2: true }, async () => {
        await expect(
          sut.issue(buildOrderDelivery(), buildSsgEvent(), undefined, activeAuthority, 1),
        ).rejects.toBeInstanceOf(SsgAutoResolveBlockedError);
      });

      expect(ssgIssue.issue).not.toHaveBeenCalled();
      expect(ssgInsertStateService.markAttempted).not.toHaveBeenCalled();
    });
  });

  describe('PIN 중복 검사 — archive UNION', () => {
    it('ssg_issue_log 에 없고 archive 에 있으면 중복으로 판정하여 재생성 시도한다', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([]);
      let dedupCallCount = 0;
      ssgIssueLogRepository.query.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('order_delivery_id')) {
          return [];
        }
        if (typeof sql === 'string' && sql.includes('bar_code')) {
          dedupCallCount++;
          return dedupCallCount <= 2 ? [{ hit: 1 }] : [];
        }
        return [];
      });

      const delivery = buildOrderDelivery();
      await sut.issue(delivery, buildSsgEvent(), undefined, activeAuthority, 1);

      expect(ssgIssueLogRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('ssg_issue_log_ops_archive'),
        expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String), expect.any(String)]),
      );
      expect(ssgIssue.generateSsgIssue).toHaveBeenCalledTimes(3);
    });

    it('classifyDeferredSsgIssue: ssg_issue_log 0행 + archive hit → UNKNOWN (NOT_ATTEMPTED 아님)', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([]);
      ssgIssueLogRepository.query.mockResolvedValue([{ hit: 1 }]);

      const result = await sut.classifyDeferredSsgIssue(9001);
      expect(result.resolution).toBe(SsgPinResolution.UNKNOWN);
      expect(result.hasAnyAttempt).toBe(true);
    });

    it('classifyDeferredSsgIssue: ssg_issue_log 0행 + archive 0행 → NOT_ATTEMPTED', async () => {
      ssgIssueLogRepository.find.mockResolvedValue([]);
      ssgIssueLogRepository.query.mockResolvedValue([]);

      const result = await sut.classifyDeferredSsgIssue(9001);
      expect(result.resolution).toBe(SsgPinResolution.NOT_ATTEMPTED);
      expect(result.hasAnyAttempt).toBe(false);
    });
  });
});
