import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderDeliveryRefundEntity } from '../../entity/order.delivery.refund.entity';
import { SsgRecoveryResult } from '../interface/ssg.recovery.result';
import { SsgRefundOutcome } from '../interface/ssg.refund.resolve';
import { SsgRecoveryService } from './ssg-recovery.service';
import { SsgRefundResolverService } from './ssg-refund.resolver';

/**
 * SsgRecoveryService 단위 테스트
 * docs/plans/2026-06-12-external-api-wallet-integration.md B-0~B-7.
 *
 * 검증 범위:
 *  - CAS claim affected=1 → resolver 호출, affected=0 → skip (resolver 미호출)
 *  - settled=true / lease 미만료 → claim affected=0 (DB WHERE 가 거름, mock 으로 시뮬레이션)
 *  - resolver DEFERRED → DEFERRED 결과 + settled 미변경(resolver 책임)
 *  - escalation: attempts 임계 초과 → escalated UPDATE affected=1 시 logger.error 1회
 */
describe('SsgRecoveryService', () => {
  let sut: SsgRecoveryService;
  let refundRepository: { createQueryBuilder: jest.Mock };
  let resolver: { resolveAndRefundIfNeeded: jest.Mock };

  const baseArgs = {
    orderDeliveryId: 77,
    ssgEventId: 36,
    orderId: 4145,
    refundAmount: 10_000,
  };

  /**
   * createQueryBuilder() 체인 mock — update(claim/escalation/heartbeat) + select(claimed id 조회) 둘 다 지원.
   * execute 는 호출 순서대로 큐에서 결과를 꺼낸다 (claim → escalation 순). getRawOne 은 claimed id 반환.
   */
  const makeUpdateChain = (executeQueue: Array<{ affected: number }>, rawOne: any) => {
    const chain: any = {
      update: jest.fn(() => chain),
      set: jest.fn(() => chain),
      select: jest.fn(() => chain),
      where: jest.fn(() => chain),
      andWhere: jest.fn(() => chain),
      execute: jest.fn(() => Promise.resolve(executeQueue.shift() ?? { affected: 0 })),
      getRawOne: jest.fn(() => Promise.resolve(rawOne)),
    };
    return chain;
  };

  const setup = (
    executeQueue: Array<{ affected: number }>,
    resolverOutcome: SsgRefundOutcome,
    rawOne: any = { id: 555 },
  ) => {
    const chain = makeUpdateChain(executeQueue, rawOne);
    refundRepository = { createQueryBuilder: jest.fn(() => chain) };
    resolver = {
      resolveAndRefundIfNeeded: jest.fn().mockResolvedValue(resolverOutcome),
    };
    return chain;
  };

  const compile = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SsgRecoveryService,
        { provide: getRepositoryToken(OrderDeliveryRefundEntity), useValue: refundRepository },
        { provide: SsgRefundResolverService, useValue: resolver },
      ],
    }).compile();
    sut = module.get(SsgRecoveryService);
  };

  afterEach(() => jest.clearAllMocks());

  it('claim affected=1 + resolver RESTORED → RESTORED, resolver 1회 호출', async () => {
    const chain = setup([{ affected: 1 }], SsgRefundOutcome.RESTORED);
    await compile();

    const result = await sut.recoverWithLease(
      baseArgs.orderDeliveryId,
      baseArgs.ssgEventId,
      baseArgs.orderId,
      baseArgs.refundAmount,
    );

    expect(result).toBe(SsgRecoveryResult.RESTORED);
    expect(resolver.resolveAndRefundIfNeeded).toHaveBeenCalledTimes(1);
    // claimed row id 를 token-fenced 로 읽어 refundLedgerId 로 전달 + recoverToken(ulid) 동봉.
    expect(resolver.resolveAndRefundIfNeeded).toHaveBeenCalledWith({
      orderDeliveryId: baseArgs.orderDeliveryId,
      ssgEventId: baseArgs.ssgEventId,
      orderId: baseArgs.orderId,
      refundAmount: baseArgs.refundAmount,
      refundLedgerId: 555,
      recoverToken: expect.any(String),
    });
    // claim UPDATE 만 execute (escalation 없음, heartbeat 은 clearInterval 로 미발화)
    expect(chain.execute).toHaveBeenCalledTimes(1);
    // claimed id SELECT
    expect(chain.getRawOne).toHaveBeenCalledTimes(1);
  });

  it('claim affected=0 (settled=true 또는 lease 미만료) → SKIPPED_NO_CLAIM, resolver 미호출', async () => {
    setup([{ affected: 0 }], SsgRefundOutcome.RESTORED);
    await compile();

    const result = await sut.recoverWithLease(
      baseArgs.orderDeliveryId,
      baseArgs.ssgEventId,
      baseArgs.orderId,
      baseArgs.refundAmount,
    );

    expect(result).toBe(SsgRecoveryResult.SKIPPED_NO_CLAIM);
    expect(resolver.resolveAndRefundIfNeeded).not.toHaveBeenCalled();
  });

  it('claim 소유 + resolver DEFERRED → DEFERRED (settled 미변경 = resolver 책임)', async () => {
    // claim affected=1, escalation affected=0 (임계 미달)
    setup([{ affected: 1 }, { affected: 0 }], SsgRefundOutcome.DEFERRED);
    await compile();

    const result = await sut.recoverWithLease(
      baseArgs.orderDeliveryId,
      baseArgs.ssgEventId,
      baseArgs.orderId,
      baseArgs.refundAmount,
    );

    expect(result).toBe(SsgRecoveryResult.DEFERRED);
    expect(resolver.resolveAndRefundIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('CAS WHERE 조건: settled=false AND lease 만료/NULL 가 쿼리에 포함', async () => {
    const chain = setup([{ affected: 1 }], SsgRefundOutcome.RESTORED);
    await compile();

    await sut.recoverWithLease(
      baseArgs.orderDeliveryId,
      baseArgs.ssgEventId,
      baseArgs.orderId,
      baseArgs.refundAmount,
    );

    const whereCalls = [
      ...chain.where.mock.calls.map((c: any[]) => c[0]),
      ...chain.andWhere.mock.calls.map((c: any[]) => c[0]),
    ].join(' | ');
    expect(whereCalls).toContain('ssg_balance_settled = false');
    expect(whereCalls).toContain('ssg_recover_lease_until IS NULL OR ssg_recover_lease_until < NOW(6)');
  });

  it('escalation: attempts 임계 초과(escalation UPDATE affected=1) → logger.error 1회', async () => {
    // claim affected=1, escalation affected=1
    setup([{ affected: 1 }, { affected: 1 }], SsgRefundOutcome.DEFERRED);
    await compile();

    const errorSpy = jest.spyOn((sut as any).logger, 'error').mockImplementation(() => undefined);

    await sut.recoverWithLease(
      baseArgs.orderDeliveryId,
      baseArgs.ssgEventId,
      baseArgs.orderId,
      baseArgs.refundAmount,
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('escalation');
  });

  it('escalation 미발생: attempts 임계 미달(escalation UPDATE affected=0) → logger.error 안 함', async () => {
    setup([{ affected: 1 }, { affected: 0 }], SsgRefundOutcome.DEFERRED);
    await compile();

    const errorSpy = jest.spyOn((sut as any).logger, 'error').mockImplementation(() => undefined);

    await sut.recoverWithLease(
      baseArgs.orderDeliveryId,
      baseArgs.ssgEventId,
      baseArgs.orderId,
      baseArgs.refundAmount,
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
