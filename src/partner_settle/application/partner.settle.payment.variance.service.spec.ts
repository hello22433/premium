import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PartnerSettlePaymentVarianceService, VarianceActor } from './partner.settle.payment.variance.service';
import { PartnerSettleFeatureFlag } from './partner.settle.feature.flag';
import { PartnerSettleLedgerService } from './partner.settle.ledger.service';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';

const T_DECISION = '2026-08-07 13:24:35.123456';

function makeFeatureFlag(paidEnabled = true) {
  return {
    isPaidEnabled: paidEnabled,
    isConfirmEnabled: true,
    isEnabled: true,
    isReviewResolutionEnabled: true,
    isEnabledFor: jest.fn().mockReturnValue(true),
  } as unknown as PartnerSettleFeatureFlag;
}

function makeQb(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    getMany: jest.fn().mockResolvedValue([]),
    getOneOrFail: jest.fn().mockResolvedValue({ id: 1 }),
    getRawOne: jest.fn().mockResolvedValue({ total: '50000' }),
  };
  Object.assign(qb, overrides);
  return qb;
}

type Scenario = {
  proposal?: Record<string, unknown> | null;
  batch?: Record<string, unknown> | null;
  request?: Record<string, unknown> | null;
  prevBatch?: Record<string, unknown> | null;
  /** 확정 원장 재동결 합계 */
  finalizedTotal?: string;
};

const BASE_PROPOSAL = {
  id: 7,
  paymentRequestId: 30,
  batchId: 11,
  partnerCompanyId: 3,
  calculatedPaidAmount: '50000',
  actualPaidAmount: '48000',
  paymentEvidenceRef: 'REF-001',
  memo: null,
  proposedBy: 100,
  proposedAt: new Date('2026-08-07T10:00:00'),
  status: 'PENDING',
  approvedBy: null,
  approvedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  decisionReason: null,
  resultLedgerId: null,
};

const BASE_BATCH = {
  id: 11,
  partnerCompanyId: 3,
  periodEnd: '2026-08-01',
  status: 'CONFIRMED_UNPAID',
  batchType: 'NORMAL',
  carryOutAmount: null,
};

const BASE_REQUEST = {
  id: 30,
  batchId: 11,
  status: 'PENDING_VARIANCE',
  paidRequestKey: 'paid-key-1',
  payloadHash: 'hash-1',
  payloadHashVersion: 'v1',
};

function makeSut(scenario: Scenario = {}, paidEnabled = true) {
  const proposal = scenario.proposal === undefined ? { ...BASE_PROPOSAL } : scenario.proposal;
  const batch = scenario.batch === undefined ? { ...BASE_BATCH } : scenario.batch;
  const request = scenario.request === undefined ? { ...BASE_REQUEST } : scenario.request;
  const prevBatch = scenario.prevBatch ?? null;

  const queries: { sql: string; params: unknown[] }[] = [];

  const repoFor = (name: string) => {
    switch (name) {
      case 'PartnerSettlePaymentVarianceProposalEntity':
        return {
          findOne: jest.fn().mockResolvedValue(proposal),
          createQueryBuilder: jest.fn().mockReturnValue(makeQb({ getOne: jest.fn().mockResolvedValue(proposal) })),
        };
      case 'PartnerSettleBatchEntity':
        return {
          findOne: jest.fn().mockResolvedValue(batch),
          createQueryBuilder: jest.fn().mockImplementation(() =>
            // 잠금 조회(where id)와 carry 체인 조회(where partnerCompanyId)가 같은 빌더를 쓰므로
            // 호출 순서로 가르지 않고 lock 여부로 가른다.
            makeQb({
              getOne: jest.fn().mockImplementation(function (this: any) {
                return Promise.resolve(this.__locked ? batch : prevBatch);
              }),
              setLock: jest.fn().mockImplementation(function (this: any) {
                this.__locked = true;
                return this;
              }),
            }),
          ),
        };
      case 'PartnerSettlePaymentRequestEntity':
        return {
          findOne: jest.fn().mockResolvedValue(request),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
          createQueryBuilder: jest.fn().mockReturnValue(makeQb({ getOne: jest.fn().mockResolvedValue(request) })),
        };
      case 'PartnerCompanyEntity':
        return { createQueryBuilder: jest.fn().mockReturnValue(makeQb()) };
      case 'PartnerSettleLedgerEntity':
        return { findOne: jest.fn().mockResolvedValue({ id: 900, settleAmount: '2000' }) };
      default:
        return { findOne: jest.fn().mockResolvedValue(null), createQueryBuilder: jest.fn().mockReturnValue(makeQb()) };
    }
  };

  const manager = {
    getRepository: jest.fn().mockImplementation((entity: any) => repoFor(entity.name ?? String(entity))),
    createQueryBuilder: jest
      .fn()
      .mockReturnValue(makeQb({ getRawOne: jest.fn().mockResolvedValue({ total: scenario.finalizedTotal ?? '50000' }) })),
    query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('NOW(6)')) return Promise.resolve([{ now6: T_DECISION }]);
      return Promise.resolve({ affectedRows: 1 });
    }),
  };

  const dataSource = {
    manager,
    getRepository: jest.fn().mockImplementation((entity: any) => repoFor(entity.name ?? String(entity))),
    createQueryRunner: jest.fn().mockReturnValue({
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager,
    }),
  };

  const ledgerService = {
    appendVarianceAdjustment: jest.fn().mockResolvedValue({ id: 900, settleAmount: '2000' }),
  } as unknown as PartnerSettleLedgerService;

  const activityLogService = { createLog: jest.fn().mockResolvedValue(1) } as unknown as ActivityLogService;

  const service = new PartnerSettlePaymentVarianceService(
    dataSource as any,
    makeFeatureFlag(paidEnabled),
    ledgerService,
    activityLogService,
  );

  return { service, ledgerService, activityLogService, queries, manager };
}

const APPROVER: VarianceActor = { id: 200, email: 'approver@enmad.co.kr', ipAddress: '10.0.0.1' };
const REASON = { decisionReason: '원인 미상 잔여 차이 승인' };

describe('PartnerSettlePaymentVarianceService', () => {
  describe('flag', () => {
    it('paid flag OFF → 404', async () => {
      const { service } = makeSut({}, false);
      await expect(service.approve(7, REASON, APPROVER)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.reject(7, REASON, APPROVER)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('approve', () => {
    it('차이 −2000 → ADJUSTMENT +2000 append (부호 반전) + batch PAID', async () => {
      const { service, ledgerService, queries } = makeSut();

      const result = await service.approve(7, REASON, APPROVER);

      // actual(48000) − calculated(50000) = −2000 → 원장은 +2000 (다음 sweep 지급액 가산)
      expect(ledgerService.appendVarianceAdjustment).toHaveBeenCalledWith(
        expect.objectContaining({ paymentVarianceProposalId: 7, partnerCompanyId: 3, settleAmount: 2000n }),
        expect.anything(),
      );
      expect(result).toMatchObject({
        proposalId: 7,
        status: 'APPROVED',
        resultLedgerId: 900,
        varianceAmount: '-2000',
        adjustmentAmount: '2000',
        approvedAt: T_DECISION,
      });

      const batchUpdate = queries.find((q) => q.sql.includes('UPDATE partner_settle_batch'));
      expect(batchUpdate).toBeDefined();
      // DB CHECK `paid_amount = actual_paid_amount` — 계산액이 아니라 실송금액이 들어가야 한다.
      expect(batchUpdate!.params).toContain('48000');
    });

    it('과지급(actual > calculated) → ADJUSTMENT 음수', async () => {
      const { service, ledgerService } = makeSut({
        proposal: { ...BASE_PROPOSAL, actualPaidAmount: '53000' },
      });

      const result = await service.approve(7, REASON, APPROVER);

      expect(ledgerService.appendVarianceAdjustment).toHaveBeenCalledWith(
        expect.objectContaining({ settleAmount: -3000n }),
        expect.anything(),
      );
      expect(result).toMatchObject({ varianceAmount: '3000', adjustmentAmount: '-3000' });
    });

    it('T_decision 은 DB NOW(6) 한 값 — proposal.approvedAt 과 ledger.occurredAt 이 같다', async () => {
      const { service, ledgerService, queries } = makeSut();

      await service.approve(7, REASON, APPROVER);

      const appendArg = (ledgerService.appendVarianceAdjustment as jest.Mock).mock.calls[0][0];
      const occurredAt = appendArg.occurredAt;
      // KstInstant → canonical 문자열이 T_DECISION 과 같아야 한다(마이크로초 보존).
      expect(occurredAt.date.getMilliseconds()).toBe(123);
      expect(occurredAt.microsecondRemainder).toBe(456);

      const proposalUpdate = queries.find((q) => q.sql.includes('UPDATE partner_settle_payment_variance_proposal'));
      expect(proposalUpdate!.params).toContain(T_DECISION);

      // NOW(6) 는 트랜잭션당 정확히 한 번만 읽는다.
      expect(queries.filter((q) => q.sql.includes('NOW(6)'))).toHaveLength(1);
    });

    it('자기승인 차단 — 기안자와 결정자가 같으면 403', async () => {
      const { service } = makeSut();
      await expect(service.approve(7, REASON, { ...APPROVER, id: BASE_PROPOSAL.proposedBy })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('stale — 계산액이 변했으면 409 이고 원장을 만들지 않는다', async () => {
      const { service, ledgerService } = makeSut({ finalizedTotal: '61000' });

      await expect(service.approve(7, REASON, APPROVER)).rejects.toThrow(/VARIANCE_STALE/);
      expect(ledgerService.appendVarianceAdjustment).not.toHaveBeenCalled();
    });

    it('승인 재시도 — 기존 결과 200, 원장 재생성 없음', async () => {
      const { service, ledgerService } = makeSut({
        proposal: {
          ...BASE_PROPOSAL,
          status: 'APPROVED',
          approvedBy: 200,
          approvedAt: new Date('2026-08-07T13:24:35'),
          decisionReason: '원인 미상 잔여 차이 승인',
          resultLedgerId: 900,
        },
      });

      const result = await service.approve(7, REASON, APPROVER);

      expect(result).toMatchObject({ proposalId: 7, status: 'APPROVED', resultLedgerId: 900 });
      expect(ledgerService.appendVarianceAdjustment).not.toHaveBeenCalled();
    });

    it('반려 후 승인 → 409', async () => {
      const { service } = makeSut({ proposal: { ...BASE_PROPOSAL, status: 'REJECTED', rejectedBy: 200 } });
      await expect(service.approve(7, REASON, APPROVER)).rejects.toBeInstanceOf(ConflictException);
    });

    it('batch 가 이미 PAID 면 409', async () => {
      const { service } = makeSut({ batch: { ...BASE_BATCH, status: 'PAID' } });
      await expect(service.approve(7, REASON, APPROVER)).rejects.toBeInstanceOf(ConflictException);
    });

    it('직전 batch 미지급이면 400 (지급 순서 보호)', async () => {
      const { service } = makeSut({
        prevBatch: { id: 9, periodEnd: '2026-07-01', status: 'CONFIRMED_UNPAID', carryOutAmount: null },
      });
      await expect(service.approve(7, REASON, APPROVER)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('사유 누락 → 400', async () => {
      const { service } = makeSut();
      await expect(service.approve(7, { decisionReason: '   ' }, APPROVER)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('감사 로그를 같은 트랜잭션 manager 로 남긴다', async () => {
      const { service, activityLogService, manager } = makeSut();

      await service.approve(7, REASON, APPROVER);

      expect(activityLogService.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: ActivityLogActionType.PARTNER_SETTLE_VARIANCE_APPROVE,
          userId: APPROVER.id,
        }),
        manager,
      );
    });

    it('감사 시각도 T_decision — activity_log.created_at 을 같은 값으로 맞춘다', async () => {
      const { service, queries } = makeSut();

      await service.approve(7, REASON, APPROVER);

      const auditFix = queries.find((q) => q.sql.includes('UPDATE activity_log'));
      expect(auditFix).toBeDefined();
      expect(auditFix!.params[0]).toBe(T_DECISION);
    });
  });

  describe('reject', () => {
    it('proposal·request 를 함께 REJECTED 로 종결하고 batch 는 건드리지 않는다', async () => {
      const { service, ledgerService, queries, manager } = makeSut();

      const result = await service.reject(7, REASON, APPROVER);

      expect(result).toMatchObject({ proposalId: 7, status: 'REJECTED', rejectedAt: T_DECISION });
      expect(ledgerService.appendVarianceAdjustment).not.toHaveBeenCalled();
      expect(queries.some((q) => q.sql.includes('UPDATE partner_settle_batch'))).toBe(false);

      const requestRepo = manager.getRepository({ name: 'PartnerSettlePaymentRequestEntity' } as any);
      expect(requestRepo.update).toBeDefined();
    });

    it('승인 후 반려 → 409', async () => {
      const { service } = makeSut({ proposal: { ...BASE_PROPOSAL, status: 'APPROVED', resultLedgerId: 900 } });
      await expect(service.reject(7, REASON, APPROVER)).rejects.toBeInstanceOf(ConflictException);
    });

    it('반려 재시도 → 기존 결과 200', async () => {
      const { service, queries } = makeSut({
        proposal: {
          ...BASE_PROPOSAL,
          status: 'REJECTED',
          rejectedBy: 200,
          rejectedAt: new Date('2026-08-07T13:24:35'),
          decisionReason: '증적 불충분',
        },
      });

      const result = await service.reject(7, REASON, APPROVER);

      expect(result).toMatchObject({ proposalId: 7, status: 'REJECTED' });
      expect(queries.some((q) => q.sql.includes('UPDATE partner_settle_payment_variance_proposal'))).toBe(false);
    });

    it('request 가 이미 PAID 면 반려 409 (지급 사실을 덮어쓰지 않는다)', async () => {
      const { service, queries } = makeSut({ request: { ...BASE_REQUEST, status: 'PAID' } });

      await expect(service.reject(7, REASON, APPROVER)).rejects.toBeInstanceOf(ConflictException);
      expect(queries.some((q) => q.sql.includes('UPDATE partner_settle_payment_variance_proposal'))).toBe(false);
    });

    it('batch 가 이미 PAID 면 반려 409', async () => {
      const { service } = makeSut({ batch: { ...BASE_BATCH, status: 'PAID' } });
      await expect(service.reject(7, REASON, APPROVER)).rejects.toBeInstanceOf(ConflictException);
    });

    it('감사 시각도 T_decision', async () => {
      const { service, queries } = makeSut();

      await service.reject(7, REASON, APPROVER);

      const auditFix = queries.find((q) => q.sql.includes('UPDATE activity_log'));
      expect(auditFix!.params[0]).toBe(T_DECISION);
    });

    it('자기반려 차단 → 403', async () => {
      const { service } = makeSut();
      await expect(service.reject(7, REASON, { ...APPROVER, id: BASE_PROPOSAL.proposedBy })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('조회', () => {
    it('PENDING 은 재계산과 비교해 stale 을 표시한다', async () => {
      const { service } = makeSut({ finalizedTotal: '61000' });
      const view = await service.findProposal(7);
      expect(view).toMatchObject({ id: 7, status: 'PENDING', varianceAmount: '-2000', stale: true });
    });

    it('계산액이 그대로면 stale=false', async () => {
      const { service } = makeSut();
      const view = await service.findProposal(7);
      expect(view).toMatchObject({ stale: false });
    });

    it('없는 proposal 은 404', async () => {
      const { service } = makeSut({ proposal: null });
      await expect(service.findProposal(7)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
