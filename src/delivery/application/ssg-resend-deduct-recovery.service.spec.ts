import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { SsgRefundResolverService } from './ssg-refund.resolver';
import { SsgRefundOutcome } from '../interface/ssg.refund.resolve';
import { SsgResendDeductRecoveryService } from './ssg-resend-deduct-recovery.service';

/**
 * SsgResendDeductRecoveryService 단위 테스트 — plans/wip4-ssg-resend-deduct-durable.md.
 *
 * 검증:
 *  - migrationAt 미설정/파싱실패 → sweep 중단
 *  - claim affected=0 → skip (findOne/역복원 미발생)
 *  - W1(issue 미시도) → refundResendEventDeduction 직접 역복원 + REVERSED (resolver 미호출)
 *  - issue 시도 + resolver RESTORED → REVERSED
 *  - issue 시도 + resolver SKIPPED_CONFIRMED → order_delivery ssg_event_id repair + KEPT
 *  - issue 시도 + resolver DEFERRED → 유지(deferred), 해소 안 함
 */
describe('SsgResendDeductRecoveryService', () => {
  let sut: SsgResendDeductRecoveryService;
  let pendingRepo: any;
  let orderDeliveryRepo: any;
  let ssgEventService: any;
  let resolver: any;
  let chain: any;
  let execResult: { affected: number };
  let candidateRows: any[];
  const origEnv = process.env.SSG_SWEEP_MIGRATION_AT;

  const makeChain = () => ({
    select: jest.fn(() => chain),
    addSelect: jest.fn(() => chain),
    update: jest.fn(() => chain),
    set: jest.fn(() => chain),
    where: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    getRawMany: jest.fn(() => Promise.resolve(candidateRows)),
    execute: jest.fn(() => Promise.resolve(execResult)),
  });

  const setup = async (row: Partial<SsgResendDeductPendingEntity> | null) => {
    chain = makeChain();
    execResult = { affected: 1 };
    candidateRows = row ? [{ id: 1 }] : [];
    pendingRepo = {
      createQueryBuilder: jest.fn(() => chain),
      findOne: jest.fn(() => Promise.resolve(row ? { id: 1, recoverToken: 'tok', ...row } : null)),
    };
    orderDeliveryRepo = { createQueryBuilder: jest.fn(() => chain) };
    ssgEventService = {
      refundResendEventDeduction: jest.fn(() => Promise.resolve()),
      resolveReissuePending: jest.fn(() => Promise.resolve()),
    };
    resolver = { resolveAndRefundIfNeeded: jest.fn(() => Promise.resolve(SsgRefundOutcome.RESTORED)) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SsgResendDeductRecoveryService,
        { provide: getRepositoryToken(SsgResendDeductPendingEntity), useValue: pendingRepo },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: orderDeliveryRepo },
        { provide: SsgEventService, useValue: ssgEventService },
        { provide: SsgRefundResolverService, useValue: resolver },
      ],
    }).compile();
    sut = module.get(SsgResendDeductRecoveryService);
  };

  afterEach(() => {
    jest.clearAllMocks();
    if (origEnv === undefined) delete process.env.SSG_SWEEP_MIGRATION_AT;
    else process.env.SSG_SWEEP_MIGRATION_AT = origEnv;
  });

  const baseRow = {
    resendDeductionId: 'rd-1',
    ssgEventId: 36,
    orderId: 4145,
    amount: 10000,
    purpose: 'BATCH_RESEND',
    issueOrderDeliveryId: 11,
    issueAttemptedAt: new Date('2026-06-16T00:00:00.000Z'),
  };

  it('SSG_SWEEP_MIGRATION_AT 미설정 → 중단(후보 조회 없음)', async () => {
    delete process.env.SSG_SWEEP_MIGRATION_AT;
    await setup(baseRow);
    const stats = await sut.sweepOnce();
    expect(pendingRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(stats).toEqual({ candidates: 0, reversed: 0, kept: 0, deferred: 0, skipped: 0 });
  });

  it('claim affected=0 → skip (findOne/역복원 미발생)', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2020-01-01T00:00:00.000Z';
    await setup(baseRow);
    execResult = { affected: 0 };
    const stats = await sut.sweepOnce();
    expect(pendingRepo.findOne).not.toHaveBeenCalled();
    expect(ssgEventService.refundResendEventDeduction).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
  });

  it('W1(issue 미시도) → refundResendEventDeduction 직접 역복원 + REVERSED, resolver 미호출', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2020-01-01T00:00:00.000Z';
    await setup({ ...baseRow, issueAttemptedAt: null });
    const stats = await sut.sweepOnce();
    expect(ssgEventService.refundResendEventDeduction).toHaveBeenCalledWith({
      resendDeductionId: 'rd-1',
      ssgEventId: 36,
      orderId: 4145,
      amount: 10000,
    });
    expect(resolver.resolveAndRefundIfNeeded).not.toHaveBeenCalled();
    expect(ssgEventService.resolveReissuePending).toHaveBeenCalledWith('rd-1', 'REVERSED');
    expect(stats.reversed).toBe(1);
  });

  it('issue 시도 + resolver RESTORED → REVERSED', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2020-01-01T00:00:00.000Z';
    await setup(baseRow);
    resolver.resolveAndRefundIfNeeded.mockResolvedValue(SsgRefundOutcome.RESTORED);
    const stats = await sut.sweepOnce();
    expect(resolver.resolveAndRefundIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ orderDeliveryId: 11, resendDeductionId: 'rd-1', refundAmount: 10000 }),
    );
    expect(ssgEventService.resolveReissuePending).toHaveBeenCalledWith('rd-1', 'REVERSED');
    expect(stats.reversed).toBe(1);
  });

  it('issue 시도 + SKIPPED_CONFIRMED → order_delivery ssg_event_id repair + KEPT', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2020-01-01T00:00:00.000Z';
    await setup(baseRow);
    resolver.resolveAndRefundIfNeeded.mockResolvedValue(SsgRefundOutcome.SKIPPED_CONFIRMED);
    const stats = await sut.sweepOnce();
    // repair UPDATE 가 order_delivery 에 대해 실행됨
    expect(orderDeliveryRepo.createQueryBuilder).toHaveBeenCalled();
    expect(ssgEventService.resolveReissuePending).toHaveBeenCalledWith('rd-1', 'KEPT');
    expect(stats.kept).toBe(1);
  });

  it('issue 시도 + DEFERRED → 유지(해소 안 함)', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2020-01-01T00:00:00.000Z';
    await setup(baseRow);
    resolver.resolveAndRefundIfNeeded.mockResolvedValue(SsgRefundOutcome.DEFERRED);
    const stats = await sut.sweepOnce();
    expect(ssgEventService.resolveReissuePending).not.toHaveBeenCalled();
    expect(stats.deferred).toBe(1);
  });
});
