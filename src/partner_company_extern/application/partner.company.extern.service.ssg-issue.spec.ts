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
import { SsgInsertStateService } from '../../delivery/application/ssg-insert-state.service';
import { MarkAttemptedResult } from '../../delivery/interface/ssg.insert.state';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import {
  SsgCheckNotFoundError,
  SsgIssueAlreadyConfirmedError,
  SsgIssueAttemptAlreadyActiveError,
  SsgIssueLogKeyCollisionError,
  SsgIssueRejectedError,
  SsgIssueUnknownError,
  SsgProcessingError,
} from '../infra/ssg.issue';
import { PartnerCompanyExternService } from './partner.company.extern.service';

/**
 * SSG issue() flow + state 통합 단위 테스트
 * plans/ssg-balance-refactor.md PR2.
 *
 * 검증 범위:
 *  - TRANSITIONED → ssgIssue.issue() → markConfirmed
 *  - SsgIssueRejectedError → markFailed + re-throw
 *  - SsgIssueUnknownError → state 유지 + re-throw (markFailed 호출 X)
 *  - SKIPPED_ACTIVE → SsgIssueAttemptAlreadyActiveError throw, issue() 호출 X
 *  - SKIPPED_TERMINAL → SsgIssueAlreadyConfirmedError throw, issue() 호출 X
 *  - 기존 PIN check 성공 → markConfirmed (legacy/orphan 동기화)
 */
describe('PartnerCompanyExternService - SSG issue flow + state', () => {
  let sut: PartnerCompanyExternService;
  let ssgIssue: { check: jest.Mock; issue: jest.Mock; generateSsgIssue: jest.Mock; getTry: jest.Mock };
  let pinIssueDedupRepository: any;
  let ssgIssueLogRepository: jest.Mocked<Repository<SsgIssueLogEntity>>;
  let orderDeliveryRepository: any;
  let partnerCompanyExternHistoryRepository: any;
  let ssgInsertStateService: {
    getState: jest.Mock;
    markAttempted: jest.Mock;
    markConfirmed: jest.Mock;
    markFailed: jest.Mock;
  };

  const makeRepoMock = () => ({
    create: jest.fn(),
    save: jest.fn(),
    insert: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    softDelete: jest.fn(),
    count: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    query: jest.fn(),
  });

  // GetSsgTry 응답(cust_info 제출여부) mock
  const tryOut = (tryYn: 'Y' | 'N') => ({
    response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ vno: ['x'], tryYn: [tryYn] }] },
  });
  // GetSsgStatus 응답(cust_info_result) mock — resultCd 로 유효/실패 구분
  const checkOut = (resultCd: string) => ({
    response: { result: [{ code: ['1001'], reason: ['ok'] }], value: [{ resultCd: [resultCd] }] },
  });

  const buildSsgEvent = (overrides: Partial<SsgEventEntity> = {}): SsgEventEntity =>
    ({
      id: 42,
      code: 'EK1',
      no: 'EV1',
      order: 1,
      name: '테스트 행사',
      startAt: new Date(),
      endAt: new Date(),
      couponExpiration: 30,
      eventPrice: 1000000,
      eventBalance: 1000000,
      ...overrides,
    }) as SsgEventEntity;

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
          name: 'SSG 테스트 상품',
          price: 5000,
          expireDay: 30,
          partnerCompanyCode: 'TEST-SSG',
          partnerCompany: { type: 'SSG' },
        },
      },
      ...overrides,
    }) as unknown as OrderDeliveryEntity;

  beforeEach(async () => {
    jest.clearAllMocks();
    ssgIssue = {
      check: jest.fn(),
      issue: jest.fn(),
      generateSsgIssue: jest.fn().mockReturnValue({ barCode: '80000001', personalCode: '01312345678' }),
      // 기본: 제출 이력 없음(N) → step2 dedup 사용 가능, step1 classify=NOT_SUBMITTED
      getTry: jest.fn().mockResolvedValue(tryOut('N')),
    };
    ssgIssueLogRepository = { ...mock<Repository<SsgIssueLogEntity>>(), ...makeRepoMock() } as unknown as jest.Mocked<
      Repository<SsgIssueLogEntity>
    >;
    pinIssueDedupRepository = { ...mock<Repository<PinIssueDedupEntity>>(), ...makeRepoMock() };
    orderDeliveryRepository = { ...mock<Repository<OrderDeliveryEntity>>(), ...makeRepoMock() };
    partnerCompanyExternHistoryRepository = {
      ...mock<Repository<PartnerCompanyExternHistoryEntity>>(),
      ...makeRepoMock(),
    };
    ssgInsertStateService = {
      getState: jest.fn(),
      markAttempted: jest.fn(),
      markConfirmed: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(true),
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
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: orderDeliveryRepository },
        {
          provide: getRepositoryToken(PartnerCompanyExternHistoryEntity),
          useValue: partnerCompanyExternHistoryRepository,
        },
        { provide: getRepositoryToken(PartnerCompanyEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PinIssueDedupEntity), useValue: pinIssueDedupRepository },
        { provide: getRepositoryToken(SsgIssueLogEntity), useValue: ssgIssueLogRepository },
        { provide: getRepositoryToken(GiftielExchangeHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GalaxiaBarcodeLogEntity), useValue: makeRepoMock() },
        { provide: CryptoCipher, useValue: { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000') } },
        { provide: SsgInsertStateService, useValue: ssgInsertStateService },
        { provide: getRepositoryToken(SsgResendDeductPendingEntity), useValue: {} },
      ],
    }).compile();

    sut = module.get(PartnerCompanyExternService);
  });

  describe('markAttempted 결과 분기', () => {
    it('TRANSITIONED → ssgIssue.issue() 호출 → markConfirmed 호출', async () => {
      const orderDelivery = buildOrderDelivery();
      const ssgEvent = buildSsgEvent();
      // 새 PIN 생성 단계에서 SSG DB 중복 확인 = NotFound (사용 가능)
      ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
      ssgInsertStateService.markAttempted.mockResolvedValue(MarkAttemptedResult.TRANSITIONED);
      ssgIssue.issue.mockResolvedValue({ response: { result: [{ code: ['1000'], reason: ['ok'] }] } });

      await sut.issue(orderDelivery, ssgEvent);

      expect(ssgInsertStateService.markAttempted).toHaveBeenCalledTimes(1);
      expect(ssgIssue.issue).toHaveBeenCalledTimes(1);
      expect(ssgInsertStateService.markConfirmed).toHaveBeenCalledWith(
        orderDelivery.id,
        expect.objectContaining({
          barCode: '80000001',
          personalCode: '01312345678',
        }),
      );
      expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
    });

    describe('ssg_issue_log 후보 충돌 → 다음 후보 재시도', () => {
      // 후보마다 다른 PIN 을 뽑도록 generateSsgIssue 를 순차 응답으로 바꾼다.
      const sequentialPins = (count: number) => {
        const pins = Array.from({ length: count }, (_, i) => ({
          barCode: `8000000${i + 1}`,
          personalCode: `0131234567${i + 1}`,
        }));
        ssgIssue.generateSsgIssue.mockReset();
        pins.forEach((pin) => ssgIssue.generateSsgIssue.mockReturnValueOnce(pin));
        return pins;
      };

      it('1차 후보 충돌 → 2차 후보로 SSG INSERT 성공, 충돌 후보에 대한 벤더 호출 0', async () => {
        const orderDelivery = buildOrderDelivery();
        const ssgEvent = buildSsgEvent();
        const pins = sequentialPins(2);
        ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
        ssgInsertStateService.markAttempted
          .mockRejectedValueOnce(new SsgIssueLogKeyCollisionError(orderDelivery.id, 'bar_code'))
          .mockResolvedValueOnce(MarkAttemptedResult.TRANSITIONED);
        ssgIssue.issue.mockResolvedValue({ response: { result: [{ code: ['1000'], reason: ['ok'] }] } });

        await sut.issue(orderDelivery, ssgEvent);

        expect(ssgInsertStateService.markAttempted).toHaveBeenCalledTimes(2);
        // 벤더 호출은 살아남은 후보에 대해 정확히 1회
        expect(ssgIssue.issue).toHaveBeenCalledTimes(1);
        expect(ssgIssue.issue.mock.calls[0][0]).toEqual(
          expect.objectContaining({ pinNo: pins[1].barCode, vno: pins[1].personalCode }),
        );
        expect(orderDelivery.barCode).toBe(pins[1].barCode);
        expect(ssgInsertStateService.markConfirmed).toHaveBeenCalledWith(
          orderDelivery.id,
          expect.objectContaining({ barCode: pins[1].barCode, personalCode: pins[1].personalCode }),
        );
      });

      it('후보 전환 시 trId 와 SSG 본문이 새 후보 기준으로 재산출된다', async () => {
        const orderDelivery = buildOrderDelivery();
        const ssgEvent = buildSsgEvent();
        const pins = sequentialPins(2);
        ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
        ssgInsertStateService.markAttempted
          .mockRejectedValueOnce(new SsgIssueLogKeyCollisionError(orderDelivery.id, 'personal_code'))
          .mockResolvedValueOnce(MarkAttemptedResult.TRANSITIONED);
        ssgIssue.issue.mockResolvedValue({ response: { result: [{ code: ['1000'], reason: ['ok'] }] } });

        await sut.issue(orderDelivery, ssgEvent);

        const firstPayload = ssgInsertStateService.markAttempted.mock.calls[0][1];
        const secondPayload = ssgInsertStateService.markAttempted.mock.calls[1][1];
        expect(firstPayload.barCode).toBe(pins[0].barCode);
        expect(secondPayload.barCode).toBe(pins[1].barCode);
        // 후보마다 새 trId 를 발급해야 한다 (stale 재사용 금지)
        expect(secondPayload.ssgTransactionId).not.toBe(firstPayload.ssgTransactionId);
        expect(orderDelivery.ssgTransactionId).toBe(secondPayload.ssgTransactionId);

        // 본문은 personalCode/barCode 를 직접 담으므로 살아남은 후보 값이어야 한다.
        const sentBody = ssgIssue.issue.mock.calls[0][0].msgContent as string;
        expect(sentBody).toContain(pins[1].personalCode);
        expect(sentBody).toContain(pins[1].barCode);
        expect(sentBody).not.toContain(pins[0].personalCode);
        expect(sentBody).not.toContain(pins[0].barCode);
        expect(ssgIssue.issue.mock.calls[0][0].trId).toBe(secondPayload.ssgTransactionId);
      });

      it('encourageDay 가 없으면 이전 시도가 남긴 encourageAt 을 null 로 지운다', async () => {
        // 실패/고아 시도가 남긴 stale 알림일. expireAt 은 무조건 재산출되므로 함께 무효화해야 한다.
        const stale = new Date('2020-01-01T00:00:00Z');
        const orderDelivery = buildOrderDelivery({ encourageAt: stale });
        const ssgEvent = buildSsgEvent();
        sequentialPins(1);
        ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
        ssgInsertStateService.markAttempted.mockResolvedValue(MarkAttemptedResult.TRANSITIONED);
        ssgIssue.issue.mockResolvedValue({ response: { result: [{ code: ['1000'], reason: ['ok'] }] } });

        await sut.issue(orderDelivery, ssgEvent);

        expect(orderDelivery.encourageAt).toBeNull();
        expect(ssgInsertStateService.markAttempted.mock.calls[0][1].encourageAt).toBeNull();
        expect(ssgInsertStateService.markConfirmed).toHaveBeenCalledWith(
          orderDelivery.id,
          expect.objectContaining({ encourageAt: null }),
        );
      });

      it('encourageDay 가 있으면 새 expireAt 기준으로 encourageAt 을 재산출한다', async () => {
        const stale = new Date('2020-01-01T00:00:00Z');
        const orderDelivery = buildOrderDelivery({ encourageAt: stale });
        orderDelivery.orderProductMapping.encourageDay = 3;
        const ssgEvent = buildSsgEvent();
        sequentialPins(1);
        ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
        ssgInsertStateService.markAttempted.mockResolvedValue(MarkAttemptedResult.TRANSITIONED);
        ssgIssue.issue.mockResolvedValue({ response: { result: [{ code: ['1000'], reason: ['ok'] }] } });

        await sut.issue(orderDelivery, ssgEvent);

        const expireAt = orderDelivery.expireAt!;
        const encourageAt = orderDelivery.encourageAt!;
        expect(encourageAt).not.toEqual(stale);
        expect(expireAt.getTime() - encourageAt.getTime()).toBe(3 * 24 * 60 * 60 * 1000);
      });

      it('후보 5회 모두 충돌 → 발급 실패로 종결, 벤더 호출 0', async () => {
        const orderDelivery = buildOrderDelivery();
        const ssgEvent = buildSsgEvent();
        sequentialPins(6);
        ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
        ssgInsertStateService.markAttempted.mockRejectedValue(
          new SsgIssueLogKeyCollisionError(orderDelivery.id, 'bar_code'),
        );

        await expect(sut.issue(orderDelivery, ssgEvent)).rejects.toThrow('SSG PIN 생성 5회 시도 후에도 중복 발생');

        // 생성 루프와 충돌 재시도가 중첩되면 25회가 된다. 전체 상한이 5 여야 한다.
        expect(ssgInsertStateService.markAttempted).toHaveBeenCalledTimes(5);
        expect(ssgIssue.generateSsgIssue).toHaveBeenCalledTimes(5);
        expect(ssgIssue.issue).not.toHaveBeenCalled();
        expect(ssgInsertStateService.markConfirmed).not.toHaveBeenCalled();
      });

      it('충돌이 아닌 markAttempted 오류는 재시도 없이 그대로 전파', async () => {
        const orderDelivery = buildOrderDelivery();
        const ssgEvent = buildSsgEvent();
        sequentialPins(2);
        ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
        const original = new Error('Lock wait timeout exceeded');
        ssgInsertStateService.markAttempted.mockRejectedValue(original);

        await expect(sut.issue(orderDelivery, ssgEvent)).rejects.toBe(original);

        expect(ssgInsertStateService.markAttempted).toHaveBeenCalledTimes(1);
        expect(ssgIssue.issue).not.toHaveBeenCalled();
      });
    });

    it('SKIPPED_ACTIVE → SsgIssueAttemptAlreadyActiveError throw, ssgIssue.issue() 호출 안 됨', async () => {
      const orderDelivery = buildOrderDelivery();
      const ssgEvent = buildSsgEvent();
      ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
      ssgInsertStateService.markAttempted.mockResolvedValue(MarkAttemptedResult.SKIPPED_ACTIVE);

      await expect(sut.issue(orderDelivery, ssgEvent)).rejects.toBeInstanceOf(SsgIssueAttemptAlreadyActiveError);
      expect(ssgIssue.issue).not.toHaveBeenCalled();
      expect(ssgInsertStateService.markConfirmed).not.toHaveBeenCalled();
      expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
    });

    it('SKIPPED_TERMINAL → SsgIssueAlreadyConfirmedError throw, ssgIssue.issue() 호출 안 됨', async () => {
      const orderDelivery = buildOrderDelivery();
      const ssgEvent = buildSsgEvent();
      ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
      ssgInsertStateService.markAttempted.mockResolvedValue(MarkAttemptedResult.SKIPPED_TERMINAL);

      await expect(sut.issue(orderDelivery, ssgEvent)).rejects.toBeInstanceOf(SsgIssueAlreadyConfirmedError);
      expect(ssgIssue.issue).not.toHaveBeenCalled();
      expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
    });
  });

  describe('issue() throw 분기', () => {
    it('SsgIssueRejectedError → markFailed + re-throw', async () => {
      const orderDelivery = buildOrderDelivery();
      const ssgEvent = buildSsgEvent();
      ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
      ssgInsertStateService.markAttempted.mockResolvedValue(MarkAttemptedResult.TRANSITIONED);
      ssgIssue.issue.mockRejectedValue(new SsgIssueRejectedError('9999', '한도 초과'));

      await expect(sut.issue(orderDelivery, ssgEvent)).rejects.toBeInstanceOf(SsgIssueRejectedError);
      expect(ssgInsertStateService.markFailed).toHaveBeenCalledWith(orderDelivery.id);
      expect(ssgInsertStateService.markConfirmed).not.toHaveBeenCalled();
    });

    it('SsgIssueUnknownError → state 유지 (markFailed 호출 X) + re-throw', async () => {
      const orderDelivery = buildOrderDelivery();
      const ssgEvent = buildSsgEvent();
      ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('미등록'));
      ssgInsertStateService.markAttempted.mockResolvedValue(MarkAttemptedResult.TRANSITIONED);
      ssgIssue.issue.mockRejectedValue(new SsgIssueUnknownError('XML 파싱 실패'));

      await expect(sut.issue(orderDelivery, ssgEvent)).rejects.toBeInstanceOf(SsgIssueUnknownError);
      expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
      expect(ssgInsertStateService.markConfirmed).not.toHaveBeenCalled();
    });
  });

  describe('기존 PIN 동기화', () => {
    it('기존 PIN 제출 이력 있음(getTry=Y) + result 유효(0100) → markConfirmed 호출, ssgIssue.issue() 호출 안 됨', async () => {
      const orderDelivery = buildOrderDelivery({
        barCode: '8EXIST01',
        personalCode: '01300001234',
        ssgTransactionId: 'tr-existing',
      });
      const ssgEvent = buildSsgEvent();
      // classifySsgPin: getTry=Y(제출됨) + GetSsgStatus resultCd=0100(정상) → REGISTERED
      ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
      ssgIssue.check.mockResolvedValue(checkOut('0100'));

      await sut.issue(orderDelivery, ssgEvent);

      expect(ssgInsertStateService.markConfirmed).toHaveBeenCalledWith(
        orderDelivery.id,
        expect.objectContaining({
          barCode: '8EXIST01',
          personalCode: '01300001234',
          ssgTransactionId: 'tr-existing',
        }),
      );
      expect(ssgInsertStateService.markAttempted).not.toHaveBeenCalled();
      expect(ssgIssue.issue).not.toHaveBeenCalled();
    });

    it('기존 PIN 미제출(getTry=N) → 새 PIN 생성 경로 진입 → markAttempted + issue() 호출', async () => {
      const orderDelivery = buildOrderDelivery({
        barCode: '8EXIST01',
        personalCode: '01300001234',
        ssgTransactionId: 'tr-existing',
      });
      const ssgEvent = buildSsgEvent();
      ssgInsertStateService.markAttempted.mockResolvedValue(MarkAttemptedResult.TRANSITIONED);
      // classifySsgPin: getTry=N → NOT_SUBMITTED → 기존 PIN 폐기 후 새 PIN. step2 dedup getTry=N = 사용 가능.
      ssgIssue.getTry.mockResolvedValue(tryOut('N'));
      ssgIssue.issue.mockResolvedValue({ response: { result: [{ code: ['1000'], reason: ['ok'] }] } });

      await sut.issue(orderDelivery, ssgEvent);

      expect(ssgInsertStateService.markAttempted).toHaveBeenCalledTimes(1);
      expect(ssgIssue.issue).toHaveBeenCalledTimes(1);
      expect(ssgInsertStateService.markConfirmed).toHaveBeenCalled();
      // 기존 PIN 은 폐기되고 새로 생성된 PIN 으로 교체
      expect(orderDelivery.barCode).toBe('80000001');
    });

    it('기존 PIN 제출됨(getTry=Y) + result 등록실패(0103 잔액부족) → 새 PIN 생성 경로', async () => {
      const orderDelivery = buildOrderDelivery({
        barCode: '8EXIST01',
        personalCode: '01300001234',
        ssgTransactionId: 'tr-existing',
      });
      const ssgEvent = buildSsgEvent();
      ssgInsertStateService.markAttempted.mockResolvedValue(MarkAttemptedResult.TRANSITIONED);
      // step1 classify: getTry=Y + resultCd=0103(등록실패) → REGISTRATION_FAILED → 기존 PIN 폐기.
      // step2 dedup 은 새 PIN(01312345678) 에 대해 getTry=N(사용가능) 이어야 하므로 분기 mock.
      ssgIssue.getTry.mockImplementation(async ({ vno }: { vno: string }) =>
        vno === '01300001234' ? tryOut('Y') : tryOut('N'),
      );
      ssgIssue.check.mockResolvedValue(checkOut('0103'));
      ssgIssue.issue.mockResolvedValue({ response: { result: [{ code: ['1000'], reason: ['ok'] }] } });

      await sut.issue(orderDelivery, ssgEvent);

      expect(ssgIssue.issue).toHaveBeenCalledTimes(1);
      expect(orderDelivery.barCode).toBe('80000001');
    });

    it('기존 PIN 제출됨(getTry=Y) + result 미반영(처리중) → SsgProcessingError throw, issue() 호출 안 됨', async () => {
      const orderDelivery = buildOrderDelivery({
        barCode: '8EXIST01',
        personalCode: '01300001234',
        ssgTransactionId: 'tr-existing',
      });
      const ssgEvent = buildSsgEvent();
      // step1 classify: getTry=Y + GetSsgStatus NotFound(8021) → PROCESSING
      ssgIssue.getTry.mockResolvedValue(tryOut('Y'));
      ssgIssue.check.mockRejectedValue(new SsgCheckNotFoundError('조회 결과 없음'));

      await expect(sut.issue(orderDelivery, ssgEvent)).rejects.toBeInstanceOf(SsgProcessingError);
      expect(ssgIssue.issue).not.toHaveBeenCalled();
      expect(ssgInsertStateService.markFailed).not.toHaveBeenCalled();
    });
  });
});
