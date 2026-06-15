import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderDeliveryRefundEntity } from '../../entity/order.delivery.refund.entity';
import { SsgRecoveryResult } from '../interface/ssg.recovery.result';
import { SsgRecoverySweepService } from './ssg-recovery-sweep.service';
import { SsgRecoveryService } from './ssg-recovery.service';

/**
 * SsgRecoverySweepService 단위 테스트
 * docs/plans/2026-06-12-external-api-wallet-integration.md B-7.
 *
 * 검증 범위:
 *  - 후보 쿼리 WHERE: settled=false AND lease 만료/NULL AND refunded_at >= migrationAt (시간 격리)
 *  - 각 후보 → recoverWithLease 호출 (refundAmount = order.sendAmount 스냅샷)
 *  - 후보 처리 예외는 흡수 후 다음 후보 진행
 */
describe('SsgRecoverySweepService', () => {
  let sut: SsgRecoverySweepService;
  let refundRepository: { createQueryBuilder: jest.Mock };
  let recoveryService: { recoverWithLease: jest.Mock };
  let qb: any;
  const origEnv = process.env.SSG_SWEEP_MIGRATION_AT;

  const makeQb = (rawRows: any[]) => {
    const chain: any = {
      innerJoin: jest.fn(() => chain),
      select: jest.fn(() => chain),
      addSelect: jest.fn(() => chain),
      where: jest.fn(() => chain),
      andWhere: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      getRawMany: jest.fn(() => Promise.resolve(rawRows)),
    };
    return chain;
  };

  const setup = async (rawRows: any[]) => {
    qb = makeQb(rawRows);
    refundRepository = { createQueryBuilder: jest.fn(() => qb) };
    recoveryService = {
      recoverWithLease: jest.fn().mockResolvedValue(SsgRecoveryResult.RESTORED),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SsgRecoverySweepService,
        { provide: getRepositoryToken(OrderDeliveryRefundEntity), useValue: refundRepository },
        { provide: SsgRecoveryService, useValue: recoveryService },
      ],
    }).compile();
    sut = module.get(SsgRecoverySweepService);
  };

  afterEach(() => {
    jest.clearAllMocks();
    if (origEnv === undefined) delete process.env.SSG_SWEEP_MIGRATION_AT;
    else process.env.SSG_SWEEP_MIGRATION_AT = origEnv;
  });

  it('후보 쿼리: settled=false + lease 만료/NULL + refunded_at >= migrationAt(시간 격리)', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2026-06-12T00:00:00.000Z';
    await setup([]);

    await sut.sweepOnce();

    const whereCalls = [
      ...qb.where.mock.calls.map((c: any[]) => c[0]),
      ...qb.andWhere.mock.calls.map((c: any[]) => c[0]),
    ].join(' | ');
    expect(whereCalls).toContain('r.ssg_balance_settled = false');
    expect(whereCalls).toContain('r.ssg_recover_lease_until IS NULL OR r.ssg_recover_lease_until < NOW(6)');
    expect(whereCalls).toContain('r.refunded_at >= :migrationAt');

    // migrationAt 파라미터가 env 값으로 바인딩됐는지 확인
    const migAtCall = qb.andWhere.mock.calls.find((c: any[]) => c[0] === 'r.refunded_at >= :migrationAt');
    expect(migAtCall[1].migrationAt).toEqual(new Date('2026-06-12T00:00:00.000Z'));
  });

  it('각 후보 → recoverWithLease 호출 (refundAmount = order.sendAmount)', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2020-01-01T00:00:00.000Z';
    await setup([
      { orderDeliveryId: 11, ssgEventId: 36, orderId: 4145, refundAmount: 10000 },
      { orderDeliveryId: 22, ssgEventId: 37, orderId: 4146, refundAmount: 5000 },
    ]);

    const stats = await sut.sweepOnce();

    expect(recoveryService.recoverWithLease).toHaveBeenCalledTimes(2);
    expect(recoveryService.recoverWithLease).toHaveBeenNthCalledWith(1, 11, 36, 4145, 10000);
    expect(recoveryService.recoverWithLease).toHaveBeenNthCalledWith(2, 22, 37, 4146, 5000);
    expect(stats.candidates).toBe(2);
    expect(stats.restored).toBe(2);
  });

  it('SSG_SWEEP_MIGRATION_AT 미설정 → sweep 중단 (후보 조회/recoverWithLease 미호출, new Date() fallback 금지)', async () => {
    delete process.env.SSG_SWEEP_MIGRATION_AT;
    await setup([{ orderDeliveryId: 11, ssgEventId: 36, orderId: 4145, refundAmount: 10000 }]);

    const stats = await sut.sweepOnce();

    expect(refundRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(recoveryService.recoverWithLease).not.toHaveBeenCalled();
    expect(stats).toEqual({ candidates: 0, restored: 0, deferred: 0, skipped: 0 });
  });

  it('SSG_SWEEP_MIGRATION_AT 파싱실패 → sweep 중단', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = 'not-a-date';
    await setup([{ orderDeliveryId: 11, ssgEventId: 36, orderId: 4145, refundAmount: 10000 }]);

    const stats = await sut.sweepOnce();

    expect(recoveryService.recoverWithLease).not.toHaveBeenCalled();
    expect(stats.candidates).toBe(0);
  });

  it('후보 처리 예외는 흡수 후 다음 후보 진행', async () => {
    process.env.SSG_SWEEP_MIGRATION_AT = '2020-01-01T00:00:00.000Z';
    await setup([
      { orderDeliveryId: 11, ssgEventId: 36, orderId: 4145, refundAmount: 10000 },
      { orderDeliveryId: 22, ssgEventId: 37, orderId: 4146, refundAmount: 5000 },
    ]);
    recoveryService.recoverWithLease
      .mockRejectedValueOnce(new Error('infra boom'))
      .mockResolvedValueOnce(SsgRecoveryResult.RESTORED);

    const stats = await sut.sweepOnce();

    expect(recoveryService.recoverWithLease).toHaveBeenCalledTimes(2);
    expect(stats.candidates).toBe(2);
    expect(stats.skipped).toBe(1);
    expect(stats.restored).toBe(1);
  });
});
