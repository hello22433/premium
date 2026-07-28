jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: PropertyDescriptor) => descriptor,
}));
import { SsgEventService } from './ssg.event.service';
import { SsgEventEntity } from '../../entity/ssg.event.entity';

describe('SsgEventService.getOpenTempDeductionByEvent', () => {
  const createService = () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(),
    };

    const amountHistoryRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    const service = new SsgEventService(
      {} as any, // ssgEventRepository
      amountHistoryRepository as any,
      {} as any, // orderProductMappingRepository
      {} as any, // reservationRangeRepository
      {} as any, // recoveryLogRepository
      {} as any, // resendDeductRecoveryRepository
      {} as any, // resendDeductPendingRepository
      {} as any, // refundLedgerRepository
      {} as any, // activityLogService
      {} as any, // ssgIssue
      { assertLegacyAllowed: jest.fn().mockResolvedValue(undefined) } as any, // cutoverGuard (§9 컷오버 게이트)
    );

    return { service, qb };
  };

  it('getOpenTempDeductionByEvent: 주문별 NET(음수) 절대값 합', async () => {
    const { service, qb } = createService();
    // 살아있는 검토중 주문 2건: -200, -100 → R=300
    qb.getRawMany.mockResolvedValue([
      { orderId: 1, net: '-200' },
      { orderId: 2, net: '-100' },
    ]);
    const r = await service.getOpenTempDeductionByEvent(1);
    expect(r).toBe(300);
  });

  it('살아있는 선차감 없으면 0', async () => {
    const { service, qb } = createService();
    qb.getRawMany.mockResolvedValue([]);
    expect(await service.getOpenTempDeductionByEvent(1)).toBe(0);
  });

  it('주문 단위 그룹핑 + HAVING(미복원 음수 차감 보유)으로 집계 — 복원/확정 주문은 SQL에서 제외', async () => {
    const { service, qb } = createService();
    qb.getRawMany.mockResolvedValue([{ orderId: 1, net: '-500' }]);
    await service.getOpenTempDeductionByEvent(1);
    expect(qb.groupBy).toHaveBeenCalledWith('h.orderId');
    expect(qb.having).toHaveBeenCalledWith(
      'SUM(CASE WHEN h.isTemporary = :t AND h.amount < 0 THEN 1 ELSE 0 END) > 0 AND SUM(h.amount) < 0',
      { t: true },
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Task 3: getSsgBalanceCheckForOrder
// ─────────────────────────────────────────────────────────────
describe('SsgEventService.getSsgBalanceCheckForOrder', () => {
  /**
   * QueryBuilder 두 종류를 케이스별로 분기해야 함:
   *   1) A_E 그룹 쿼리 (select/addSelect/where/andWhere×2/groupBy/getRawMany)
   *   2) R 쿼리 (getOpenTempDeductionByEvent 내부, select/where/andWhere/getRawOne)
   *
   * createQueryBuilder 호출 순서로 분기: 1번째=A_E, 2번째=R
   */
  const makeEvent = (overrides: Partial<SsgEventEntity> = {}): SsgEventEntity =>
    ({
      id: 10,
      no: 'EVT001',
      order: 1,
      name: '행사A',
      eventBalance: 995,
      eventPrice: 1000,
      ...overrides,
    }) as SsgEventEntity;

  const createService = (options: {
    historyGroups?: { ssgEventId: number; sum: string }[];
    event?: SsgEventEntity | null;
    getAmountResult?: { tryAmt: number; successAmt: number; failAmt: number; pendingAmt: number } | Error;
    rSum?: string | null;
  }) => {
    const {
      historyGroups = [{ ssgEventId: 10, sum: '-1' }],
      event = makeEvent(),
      getAmountResult = { tryAmt: 5, successAmt: 0, failAmt: 5, pendingAmt: 0 },
      rSum = '-1',
    } = options;

    // A_E 그룹 qb
    const groupQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(historyGroups),
    };

    // R qb (getOpenTempDeductionByEvent 내부) — 주문별 NET getRawMany
    const rQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rSum == null ? [] : [{ orderId: 1, net: rSum }]),
    };

    let callCount = 0;
    const amountHistoryRepository = {
      createQueryBuilder: jest.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? groupQb : rQb;
      }),
    };

    const ssgEventRepository = {
      findOne: jest.fn().mockResolvedValue(event),
    };

    const ssgIssue = {
      getAmount:
        getAmountResult instanceof Error
          ? jest.fn().mockRejectedValue(getAmountResult)
          : jest.fn().mockResolvedValue(getAmountResult),
    };

    const service = new SsgEventService(
      ssgEventRepository as any,
      amountHistoryRepository as any,
      {} as any, // orderProductMappingRepository
      {} as any, // reservationRangeRepository
      {} as any, // recoveryLogRepository
      {} as any, // resendDeductRecoveryRepository
      {} as any, // resendDeductPendingRepository
      {} as any, // refundLedgerRepository
      {} as any, // activityLogService
      ssgIssue as any,
      { assertLegacyAllowed: jest.fn().mockResolvedValue(undefined) } as any, // cutoverGuard (§9 컷오버 게이트)
    );

    return { service, ssgIssue, ssgEventRepository };
  };

  it('발급실패 있으면 hasWarning=true, lookupFailed=false', async () => {
    // A_E=1, failAmt=5 → A1_issueFail=true
    const { service } = createService({
      historyGroups: [{ ssgEventId: 10, sum: '-1' }],
      event: makeEvent({ eventBalance: 995, eventPrice: 1000 }),
      getAmountResult: { tryAmt: 5, successAmt: 0, failAmt: 5, pendingAmt: 0 },
      rSum: '-1',
    });

    const r = await service.getSsgBalanceCheckForOrder(123);
    expect(r).not.toBeNull();
    expect(r!.hasWarning).toBe(true);
    expect(r!.lookupFailed).toBe(false);
    expect(r!.events[0].signals.A1_issueFail).toBe(true);
  });

  it('SSG getAmount 실패 시 lookupFailed=true, 예외 전파 안 함', async () => {
    const { service } = createService({
      historyGroups: [{ ssgEventId: 10, sum: '-1000' }],
      getAmountResult: new Error('timeout'),
    });

    const r = await service.getSsgBalanceCheckForOrder(123);
    expect(r).not.toBeNull();
    expect(r!.lookupFailed).toBe(true);
  });

  it('차감이력은 있는데 행사 삭제(내부 불일치)면 lookupFailed=true, 해당 행사 누락 숨기지 않음', async () => {
    const { service } = createService({
      historyGroups: [{ ssgEventId: 10, sum: '-500' }],
      event: null,
    });

    const r = await service.getSsgBalanceCheckForOrder(123);
    expect(r).not.toBeNull();
    expect(r!.lookupFailed).toBe(true);
    expect(r!.events).toHaveLength(0);
  });

  it('비-SSG 주문(차감이력 없음)이면 null', async () => {
    const { service } = createService({
      historyGroups: [],
    });

    const r = await service.getSsgBalanceCheckForOrder(999);
    expect(r).toBeNull();
  });

  it('getAmount에 eventNo/eventSeq를 올바르게 매핑해 호출', async () => {
    const event = makeEvent({ no: 'E999', order: 3 });
    const { service, ssgIssue } = createService({ event });

    await service.getSsgBalanceCheckForOrder(123);

    expect(ssgIssue.getAmount).toHaveBeenCalledWith({ eventNo: 'E999', eventSeq: 3 });
  });

  it('경고 없는 정상 행사는 hasWarning=false', async () => {
    // 정합: Bal = P - R - (S+F+Pend) = 1000 - 100 - 100 = 800 → ρ=0, F=0, ssgRemaining(900) >= A_E(100)
    const { service } = createService({
      historyGroups: [{ ssgEventId: 10, sum: '-100' }],
      event: makeEvent({ eventBalance: 800, eventPrice: 1000 }),
      getAmountResult: { tryAmt: 100, successAmt: 100, failAmt: 0, pendingAmt: 0 },
      rSum: '-100',
    });

    const r = await service.getSsgBalanceCheckForOrder(123);
    expect(r!.hasWarning).toBe(false);
    expect(r!.lookupFailed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// #1 보강: 다중 행사 병렬 실행 + getAmount timeout 후 응답 반환
// ─────────────────────────────────────────────────────────────
describe('SsgEventService.getSsgBalanceCheckForOrder 병렬/타임아웃', () => {
  /**
   * getAmount 를 외부에서 제어 가능한 deferred 로 만든 service.
   * findOne 은 id 별 행사를 반환, R 쿼리는 0 으로 고정.
   */
  const buildControllable = (
    historyGroups: { ssgEventId: number; sum: string }[],
    getAmountImpl: jest.Mock,
    events: Record<number, SsgEventEntity | null>,
  ) => {
    const groupQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(historyGroups),
    };
    const rQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    let callCount = 0;
    const amountHistoryRepository = {
      createQueryBuilder: jest.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? groupQb : rQb;
      }),
    };
    const ssgEventRepository = {
      findOne: jest.fn().mockImplementation(({ where: { id } }: any) => Promise.resolve(events[id] ?? null)),
    };
    const ssgIssue = { getAmount: getAmountImpl };

    const service = new SsgEventService(
      ssgEventRepository as any,
      amountHistoryRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      ssgIssue as any,
      { assertLegacyAllowed: jest.fn().mockResolvedValue(undefined) } as any, // cutoverGuard (§9 컷오버 게이트)
    );
    return { service, getAmountImpl };
  };

  const evt = (id: number, no: string, order: number): SsgEventEntity =>
    ({ id, no, order, name: `행사${id}`, eventBalance: 1000, eventPrice: 1000 }) as SsgEventEntity;

  const flush = () => new Promise<void>((r) => setImmediate(r));

  it('다중 행사를 병렬 호출한다(직렬 대기 아님)', async () => {
    // getAmount 를 deferred 로: 둘 다 미해결인 상태에서 2회 모두 호출됐는지로 병렬 입증
    const resolvers: ((v: any) => void)[] = [];
    const getAmount = jest.fn().mockImplementation(() => new Promise((res) => resolvers.push(res)));
    const { service } = buildControllable(
      [
        { ssgEventId: 10, sum: '-1' },
        { ssgEventId: 20, sum: '-1' },
      ],
      getAmount,
      { 10: evt(10, 'E10', 1), 20: evt(20, 'E20', 2) },
    );

    const p = service.getSsgBalanceCheckForOrder(123);
    await flush(); // findOne(microtask) 통과 후 두 getAmount 디스패치

    // 직렬이면 첫 getAmount 가 resolve 되기 전엔 두번째가 안 불린다 → 2회면 병렬
    expect(getAmount).toHaveBeenCalledTimes(2);

    resolvers.forEach((res) => res({ tryAmt: 0, successAmt: 0, failAmt: 0, pendingAmt: 0 }));
    const r = await p;
    expect(r!.events).toHaveLength(2);
    expect(r!.lookupFailed).toBe(false);
  });

  it('getAmount 가 timeout 을 넘기면 lookupFailed=true 로 상세 응답을 반환(무한 대기 아님)', async () => {
    jest.useFakeTimers();
    try {
      const getAmount = jest.fn().mockImplementation(() => new Promise(() => {})); // 영원히 미해결
      const { service } = buildControllable([{ ssgEventId: 10, sum: '-1' }], getAmount, { 10: evt(10, 'E10', 1) });

      const p = service.getSsgBalanceCheckForOrder(123);
      await jest.advanceTimersByTimeAsync(3001); // SSG_BALANCE_CHECK_TIMEOUT_MS 초과
      const r = await p;

      expect(r!.lookupFailed).toBe(true);
      expect(r!.events).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
