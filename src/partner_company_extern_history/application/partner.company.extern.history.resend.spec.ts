import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PartnerCompanyExternHistoryService } from './partner.company.extern.history.service';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgInsertStateService } from '../../delivery/application/ssg-insert-state.service';
import { SsgInsertState } from '../../delivery/interface/ssg.insert.state';
import { SsgOrphanResolveOutcome } from '../../partner_company_extern/interface/ssg.orphan.resolve';
import { SsgPinVerdict } from '../../partner_company_extern/interface/ssg.issue';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IProductType } from '../../product/interface/product.type';

/**
 * resendFailedDelivery 단위 테스트 — self-deadlock fix(배치 동시성 모델 전환).
 *
 * 검증:
 *  - claim affected=0 → 이미 처리 중 (동시 재발송 차단)
 *  - 성공 → owner-guarded 부분 update(resendAt, claimedAt=null), 전체 save 미호출
 *  - oneSend 실패 → owner-guarded claim 해제
 *  - SSG ATTEMPTED → resolveSsgOrphan 분기 (CONFIRMED/FAILED/미확정)
 *  - SSG CONFIRMED → PIN 정상이면 발송, 유실이면 ssg_issue_log 복원, 복원 실패면 보류
 *  - 모든 해제는 owner guard(claimed_at=:claimAt) 조건부
 */
describe('PartnerCompanyExternHistoryService.resendFailedDelivery', () => {
  let sut: PartnerCompanyExternHistoryService;
  let qb: any;
  let orderDeliveryRepository: { createQueryBuilder: jest.Mock; update: jest.Mock };
  let deliveryBatchService: { oneSend: jest.Mock };
  let partnerCompanyExternService: { resolveSsgOrphan: jest.Mock; classifySsgResendPin: jest.Mock };
  let ssgInsertStateService: { getState: jest.Mock; restoreConfirmedPinFromIssueLog: jest.Mock };

  const SSG = IPartnerCompanyType.SSG;

  function makeDelivery(overrides: Partial<any> = {}): any {
    return {
      id: 584170,
      status: IOrderDeliveryStatus.FAIL,
      barCode: '85031764',
      personalCode: '01360325575',
      transactionId: 'ENM1D584170R1',
      orderProductMapping: {
        order: { id: 4653 },
        product: {
          type: IProductType.GENERAL,
          deletedAt: null,
          partnerCompany: { type: SSG },
        },
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    orderDeliveryRepository = {
      createQueryBuilder: jest.fn(() => qb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    deliveryBatchService = { oneSend: jest.fn().mockResolvedValue(true) };
    partnerCompanyExternService = {
      resolveSsgOrphan: jest.fn(),
      // 기본: 기존 PIN 등록 유효 → 재사용(proceed). barCode 있는 SSG 재발송은 게이트가 이걸 먼저 호출.
      classifySsgResendPin: jest.fn().mockResolvedValue(SsgPinVerdict.REGISTERED),
    };
    ssgInsertStateService = {
      getState: jest.fn().mockResolvedValue(SsgInsertState.NONE),
      restoreConfirmedPinFromIssueLog: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerCompanyExternHistoryService,
        { provide: getRepositoryToken(PartnerCompanyExternHistoryEntity), useValue: {} },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: orderDeliveryRepository },
        { provide: CryptoCipher, useValue: {} },
        { provide: DeliveryBatchService, useValue: deliveryBatchService },
        { provide: PartnerCompanyExternService, useValue: partnerCompanyExternService },
        { provide: SsgInsertStateService, useValue: ssgInsertStateService },
      ],
    }).compile();

    sut = module.get(PartnerCompanyExternHistoryService);
  });

  it('claim affected=0 + 최근 claimedAt → 처리 중 안내, oneSend 미호출', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery()) // 대상 조회
      .mockResolvedValueOnce(makeDelivery({ claimedAt: new Date() })); // 거부 사유 재조회
    qb.execute.mockResolvedValueOnce({ affected: 0 }); // claim 실패

    const res = await sut.resendFailedDelivery(584170);

    expect(res.success).toBe(false);
    expect(res.message).toContain('처리 중');
    expect(deliveryBatchService.oneSend).not.toHaveBeenCalled();
  });

  it('성공 → 부분 update(resendAt, claimedAt=null) owner guard 호출, oneSend true', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery()) // 대상
      .mockResolvedValueOnce(makeDelivery()); // claim 후 reload
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);
    deliveryBatchService.oneSend.mockResolvedValue(true);

    const res = await sut.resendFailedDelivery(584170);

    expect(res.success).toBe(true);
    // 성공 update 는 owner guard(claimedAt) 조건부, resendAt 세팅 + claimedAt 해제
    const successCall = orderDeliveryRepository.update.mock.calls.find(
      (c) => c[1] && 'resendAt' in c[1],
    );
    expect(successCall).toBeDefined();
    expect(successCall![0]).toEqual(expect.objectContaining({ id: 584170 }));
    expect(successCall![0]).toHaveProperty('claimedAt'); // owner guard
    expect(successCall![1]).toEqual(expect.objectContaining({ claimedAt: null }));
  });

  it('oneSend 실패 → owner-guarded claim 해제', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery())
      .mockResolvedValueOnce(makeDelivery());
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);
    deliveryBatchService.oneSend.mockResolvedValue(false);

    const res = await sut.resendFailedDelivery(584170);

    expect(res.success).toBe(false);
    const releaseCall = orderDeliveryRepository.update.mock.calls.find(
      (c) => c[1] && c[1].claimedAt === null && !('resendAt' in c[1]),
    );
    expect(releaseCall).toBeDefined();
    expect(releaseCall![0]).toHaveProperty('claimedAt'); // owner guard
  });

  it('SSG ATTEMPTED + resolver CONFIRMED → reload 후 oneSend 진행', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery()) // 대상
      .mockResolvedValueOnce(makeDelivery({ barCode: null })) // claim 후 reload (PIN 유실 가정)
      .mockResolvedValueOnce(makeDelivery()); // resolver CONFIRMED 후 reload(B)
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
    partnerCompanyExternService.resolveSsgOrphan.mockResolvedValue(SsgOrphanResolveOutcome.CONFIRMED);

    const res = await sut.resendFailedDelivery(584170);

    expect(partnerCompanyExternService.resolveSsgOrphan).toHaveBeenCalledWith(584170);
    expect(deliveryBatchService.oneSend).toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it('SSG ATTEMPTED + resolver NETWORK_UNKNOWN → 발송 보류 + claim 해제, oneSend 미호출', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery())
      .mockResolvedValueOnce(makeDelivery({ barCode: null }));
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
    partnerCompanyExternService.resolveSsgOrphan.mockResolvedValue(SsgOrphanResolveOutcome.NETWORK_UNKNOWN);

    const res = await sut.resendFailedDelivery(584170);

    expect(res.success).toBe(false);
    expect(deliveryBatchService.oneSend).not.toHaveBeenCalled();
    const releaseCall = orderDeliveryRepository.update.mock.calls.find(
      (c) => c[1] && c[1].claimedAt === null,
    );
    expect(releaseCall).toBeDefined();
  });

  it('SSG CONFIRMED + barCode 정상 → 복원 안 함, oneSend 진행', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery())
      .mockResolvedValueOnce(makeDelivery()); // barCode 정상
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);

    const res = await sut.resendFailedDelivery(584170);

    expect(ssgInsertStateService.restoreConfirmedPinFromIssueLog).not.toHaveBeenCalled();
    expect(deliveryBatchService.oneSend).toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it('SSG CONFIRMED + barCode 유실 + 복원 성공 → reload 후 oneSend', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery())
      .mockResolvedValueOnce(makeDelivery({ barCode: null, personalCode: null })) // 유실
      .mockResolvedValueOnce(makeDelivery()); // 복원 후 reload(B)
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);
    ssgInsertStateService.restoreConfirmedPinFromIssueLog.mockResolvedValue(true);

    const res = await sut.resendFailedDelivery(584170);

    expect(ssgInsertStateService.restoreConfirmedPinFromIssueLog).toHaveBeenCalledWith(584170);
    expect(deliveryBatchService.oneSend).toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it('SSG CONFIRMED + barCode 유실 + 복원 실패 → 발송 보류 + claim 해제', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery())
      .mockResolvedValueOnce(makeDelivery({ barCode: null, personalCode: null }));
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);
    ssgInsertStateService.restoreConfirmedPinFromIssueLog.mockResolvedValue(false);

    const res = await sut.resendFailedDelivery(584170);

    expect(res.success).toBe(false);
    expect(res.message).toContain('PIN 정보가 유실');
    expect(deliveryBatchService.oneSend).not.toHaveBeenCalled();
  });

  it('NONE/FAILED → 게이트 통과, oneSend 직행 (resolver 미호출)', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery({ barCode: null })) // 미발급
      .mockResolvedValueOnce(makeDelivery({ barCode: null }));
    ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.FAILED);

    const res = await sut.resendFailedDelivery(584170);

    expect(partnerCompanyExternService.resolveSsgOrphan).not.toHaveBeenCalled();
    expect(deliveryBatchService.oneSend).toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it('SSG 기존 PIN 처리중(classify=PROCESSING) → 처리중 안내 + claim 해제, oneSend 미호출', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery())
      .mockResolvedValueOnce(makeDelivery()); // barCode 정상 → verdict 경로
    partnerCompanyExternService.classifySsgResendPin.mockResolvedValue(SsgPinVerdict.PROCESSING);

    const res = await sut.resendFailedDelivery(584170);

    expect(res.success).toBe(false);
    expect(res.message).toContain('처리중');
    expect(deliveryBatchService.oneSend).not.toHaveBeenCalled();
    const releaseCall = orderDeliveryRepository.update.mock.calls.find(
      (c) => c[1] && c[1].claimedAt === null,
    );
    expect(releaseCall).toBeDefined();
  });

  it('SSG 기존 PIN 미제출(classify=NOT_SUBMITTED) → PIN 폐기 후 새 PIN 발송 진행', async () => {
    const reload = makeDelivery();
    qb.getOne
      .mockResolvedValueOnce(makeDelivery())
      .mockResolvedValueOnce(reload);
    partnerCompanyExternService.classifySsgResendPin.mockResolvedValue(SsgPinVerdict.NOT_SUBMITTED);
    deliveryBatchService.oneSend.mockResolvedValue(true);

    const res = await sut.resendFailedDelivery(584170);

    expect(reload.barCode).toBeNull();
    expect(reload.personalCode).toBeNull();
    expect(deliveryBatchService.oneSend).toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it('대상 조회 null + 재조회도 행 없음 → 대상 못 찾음 안내', async () => {
    qb.getOne
      .mockResolvedValueOnce(null) // buildResendQuery 대상 없음
      .mockResolvedValueOnce(null); // 거부 사유 재조회도 없음

    const res = await sut.resendFailedDelivery(584170);

    expect(res.success).toBe(false);
    expect(res.message).toContain('찾을 수 없습니다');
    expect(deliveryBatchService.oneSend).not.toHaveBeenCalled();
  });

  // --- 거부 사유 판정 (classifyResendRejection): status 를 claimedAt 보다 먼저 본다 ---

  it('claim affected=0 + status 비대상(COMPLETE) → 이미 완료 안내 (claimedAt 남아도 status 우선)', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery())
      // 성공 마무리 구간: status=COMPLETE 인데 claimedAt 해제만 아직 안 됨
      .mockResolvedValueOnce(
        makeDelivery({ status: IOrderDeliveryStatus.COMPLETE, claimedAt: new Date() }),
      );
    qb.execute.mockResolvedValueOnce({ affected: 0 });

    const res = await sut.resendFailedDelivery(584170);

    expect(res.success).toBe(false);
    expect(res.message).toContain('이미 완료');
    expect(res.message).not.toContain('처리 중');
  });

  it('claim affected=0 + status 대상 + claimedAt 없음/오래됨 → 상태 변경(새로고침) 안내', async () => {
    qb.getOne
      .mockResolvedValueOnce(makeDelivery())
      // status FAIL 유지 + claimedAt 6분 전(=stale, 이미 풀렸어야 할 잔재) → fallback
      .mockResolvedValueOnce(
        makeDelivery({ claimedAt: new Date(Date.now() - 6 * 60 * 1000) }),
      );
    qb.execute.mockResolvedValueOnce({ affected: 0 });

    const res = await sut.resendFailedDelivery(584170);

    expect(res.success).toBe(false);
    expect(res.message).toContain('새로고침');
  });

  describe('5분 경계 (fake timer)', () => {
    beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-06-09T00:00:00.000Z')));
    afterEach(() => jest.useRealTimers());

    it('정확히 5분 전 claimedAt → 처리 중 (경계 포함)', async () => {
      const exactlyStale = new Date(Date.now() - 5 * 60 * 1000);
      qb.getOne
        .mockResolvedValueOnce(makeDelivery())
        .mockResolvedValueOnce(makeDelivery({ claimedAt: exactlyStale }));
      qb.execute.mockResolvedValueOnce({ affected: 0 });

      const res = await sut.resendFailedDelivery(584170);

      expect(res.message).toContain('처리 중'); // claimedAt >= stale → 처리 중
    });

    it('5분+1ms 전 claimedAt → fallback (경계 밖)', async () => {
      const justStale = new Date(Date.now() - (5 * 60 * 1000 + 1));
      qb.getOne
        .mockResolvedValueOnce(makeDelivery())
        .mockResolvedValueOnce(makeDelivery({ claimedAt: justStale }));
      qb.execute.mockResolvedValueOnce({ affected: 0 });

      const res = await sut.resendFailedDelivery(584170);

      expect(res.message).toContain('새로고침'); // claimedAt < stale → fallback
    });

    it('claim 쿼리는 (claimedAt IS NULL OR claimedAt < :stale) 와 now-5분 threshold 를 사용한다', async () => {
      qb.getOne
        .mockResolvedValueOnce(makeDelivery())
        .mockResolvedValueOnce(makeDelivery({ claimedAt: new Date() })); // affected=0 후 재조회
      qb.execute.mockResolvedValueOnce({ affected: 0 });

      await sut.resendFailedDelivery(584170);

      const staleWhere = qb.andWhere.mock.calls.find((c: any[]) =>
        /claimedAt IS NULL OR claimedAt < :stale/.test(c[0]),
      );
      expect(staleWhere).toBeDefined();
      const expectedStale = new Date(Date.now() - 5 * 60 * 1000);
      expect((staleWhere![1].stale as Date).getTime()).toBe(expectedStale.getTime());
    });
  });

  // --- 부팅 orphan 해제 (releaseOrphanedResendClaims) ---

  it('releaseOrphanedResendClaims: FAIL/FAIL_SMS + claimedAt NOT NULL 범위, claimedAt만 null (status/resendAt 불변)', async () => {
    qb.execute.mockResolvedValueOnce({ affected: 3 });

    const released = await sut.releaseOrphanedResendClaims();

    expect(released).toBe(3);
    // 해제 범위: status IN (FAIL, FAIL_SMS) — WAIT 미포함
    const statusWhere = qb.where.mock.calls.find((c: any[]) => /status IN/.test(c[0]));
    expect(statusWhere).toBeDefined();
    expect(statusWhere![1].statuses).toEqual([
      IOrderDeliveryStatus.FAIL,
      IOrderDeliveryStatus.FAIL_SMS,
    ]);
    expect(statusWhere![1].statuses).not.toContain(IOrderDeliveryStatus.WAIT);
    // claimedAt IS NOT NULL 조건
    expect(qb.andWhere.mock.calls.some((c: any[]) => /claimedAt IS NOT NULL/.test(c[0]))).toBe(true);
    // 상태 불변: set 은 claimedAt:null 만 (status/resendAt 미포함)
    const setArg = qb.set.mock.calls[qb.set.mock.calls.length - 1][0];
    expect(setArg).toEqual({ claimedAt: null });
    expect(setArg).not.toHaveProperty('status');
    expect(setArg).not.toHaveProperty('resendAt');
  });
});
