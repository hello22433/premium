jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: PropertyDescriptor) => descriptor,
}));
import { SsgEventService } from './ssg.event.service';
import { SsgEventEntity } from '../../entity/ssg.event.entity';

describe('SsgEventService.getOpenTempDeductionByEvent', () => {
  const createService = () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(),
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
      {} as any, // refundLedgerRepository
      {} as any, // activityLogService
      {} as any, // ssgIssue
    );

    return { service, qb };
  };

  it('getOpenTempDeductionByEvent: 미확정(isTemporary=true) 차감 절대값 합', async () => {
    const { service, qb } = createService();
    qb.getRawOne.mockResolvedValue({ sum: '-300' });
    const r = await service.getOpenTempDeductionByEvent(1);
    expect(r).toBe(300);
  });

  it('이력 없으면 0', async () => {
    const { service, qb } = createService();
    qb.getRawOne.mockResolvedValue({ sum: null });
    expect(await service.getOpenTempDeductionByEvent(1)).toBe(0);
  });

  it('충전 등 양수 history 제외 — amount<0 필터 적용', async () => {
    const { service, qb } = createService();
    qb.getRawOne.mockResolvedValue({ sum: '-500' });
    await service.getOpenTempDeductionByEvent(1);
    expect(qb.andWhere).toHaveBeenCalledWith('h.amount < 0');
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
    } as SsgEventEntity);

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

    // R qb (getOpenTempDeductionByEvent 내부)
    const rQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ sum: rSum }),
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
      getAmount: getAmountResult instanceof Error
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
      {} as any, // refundLedgerRepository
      {} as any, // activityLogService
      ssgIssue as any,
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
