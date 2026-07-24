import { ActivityLogService } from './activity.log.service';

/**
 * getBalanceHistoryByUserId — 예치금 이력 탭 소스.
 * 여신복구(DISCARD_RESTORE + restoreType=ALL_SETTLE_AMOUNT)는 예치금/선입금 이동이 아니므로
 * 예치금 이력에서 제외돼야 한다(저장부 user_task_history 제외 규칙과 정합).
 */
describe('ActivityLogService.getBalanceHistoryByUserId', () => {
  const buildQbSpy = () => {
    const andWhereCalls: string[] = [];
    const qb: any = {
      where: jest.fn(() => qb),
      andWhere: jest.fn((clause: string) => {
        andWhereCalls.push(clause);
        return qb;
      }),
      orderBy: jest.fn(() => qb),
      getMany: jest.fn(async () => []),
    };
    return { qb, andWhereCalls };
  };

  const makeSut = (qb: any) => {
    const activityLogRepository = { createQueryBuilder: jest.fn(() => qb) } as any;
    return new ActivityLogService(activityLogRepository, {} as any, {} as any);
  };

  it('여신복구(ALL_SETTLE_AMOUNT)를 예치금 이력에서 제외하는 andWhere 절을 포함한다', async () => {
    const { qb, andWhereCalls } = buildQbSpy();
    const sut = makeSut(qb);

    await sut.getBalanceHistoryByUserId(43);

    const creditExclusion = andWhereCalls.find(
      (c) => c.includes('DISCARD_RESTORE') && c.includes('ALL_SETTLE_AMOUNT'),
    );
    expect(creditExclusion).toBeDefined();
    // restoreType 없는 과거 로그는 노출되도록 COALESCE 하위호환 처리.
    expect(creditExclusion).toContain('COALESCE');
    expect(qb.getMany).toHaveBeenCalledTimes(1);
  });

  it('예치금 이동 actionType 화이트리스트(BALANCE_*/DISCARD_RESTORE)로 조회한다', async () => {
    const { qb } = buildQbSpy();
    const sut = makeSut(qb);

    await sut.getBalanceHistoryByUserId(43);

    const inClause = qb.andWhere.mock.calls.find(
      ([clause]: [string]) => typeof clause === 'string' && clause.includes('actionType IN'),
    );
    expect(inClause).toBeDefined();
    expect(inClause[1].actionTypes).toEqual([
      'BALANCE_CHARGE',
      'BALANCE_MODIFY',
      'BALANCE_REFUND',
      'DISCARD_RESTORE',
    ]);
  });
});
