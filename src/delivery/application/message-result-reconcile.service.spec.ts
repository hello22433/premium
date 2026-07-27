import { MessageResultReconcileService } from './message-result-reconcile.service';
import { MessageAttemptStatus, MessageAttemptChannel, MessageAttemptType } from '../interface/message.attempt.status';
import { DeliveryWorkflowStatus } from '../interface/delivery.workflow.status';

/**
 * 결과 조회·재조정 배치.
 * plans/프리미엄_발송실패_재발송_구상.md §4(코드 정책) / §7.1(SLA) / §7.3(증분 탐색) / §10 2단계(자동 재발송 비활성).
 */
describe('MessageResultReconcileService — 결과 조회·재조정', () => {
  const now = new Date('2026-07-27T12:00:00');

  const attempt = (override: Partial<Record<string, unknown>> = {}) =>
    ({
      attemptId: 'a'.repeat(32),
      orderDeliveryId: 500,
      channel: MessageAttemptChannel.MMS,
      attemptType: MessageAttemptType.INITIAL,
      retryOfAttemptId: null,
      status: MessageAttemptStatus.TRACKING,
      mseq: '1001',
      receiptMonth: '202607',
      nextSearchMonth: '202607',
      cancelRequestedAt: null,
      createdAt: new Date('2026-07-27T09:00:00'),
      stateEnteredAt: new Date('2026-07-27T09:00:00'),
      ...override,
    }) as never;

  const createService = (options: {
    tracking?: unknown[];
    reconciling?: unknown[];
    resultByMseq?: jest.Mock;
    resultByAttemptId?: jest.Mock;
    queueMseq?: jest.Mock;
    auto504?: boolean;
    pendingCount?: number;
  }) => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const workflowUpdates: { set: Record<string, unknown>; where: string[] }[] = [];

    const attemptRepository = {
      find: jest
        .fn()
        .mockImplementationOnce(async () => options.tracking ?? [])
        .mockImplementationOnce(async () => options.reconciling ?? [])
        .mockImplementation(async () => []),
      update,
      count: jest.fn().mockResolvedValue(options.pendingCount ?? 0),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      }),
    } as never;

    const workflowRepository = {
      createQueryBuilder: jest.fn().mockImplementation(() => {
        const captured: { set: Record<string, unknown>; where: string[] } = { set: {}, where: [] };
        workflowUpdates.push(captured);
        const qb: Record<string, unknown> = {
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
            captured.set = values;
            return qb;
          }),
          where: jest.fn().mockImplementation((sql: string) => {
            captured.where.push(sql);
            return qb;
          }),
          andWhere: jest.fn().mockImplementation((sql: string) => {
            captured.where.push(sql);
            return qb;
          }),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        return qb;
      }),
    } as never;

    const gemtekResultQuery = {
      findByMseq: options.resultByMseq ?? jest.fn().mockResolvedValue(null),
      findByAttemptId: options.resultByAttemptId ?? jest.fn().mockResolvedValue(null),
    } as never;

    const smsGemtekSend = { findMseqByAttemptId: options.queueMseq ?? jest.fn().mockResolvedValue(null) } as never;
    const configService = {
      get: jest
        .fn()
        .mockImplementation((key: string) =>
          key === 'DELIVERY_AUTO_RESEND_504_ENABLED' ? (options.auto504 ? 'true' : 'false') : undefined,
        ),
    } as never;

    return {
      service: new MessageResultReconcileService(
        attemptRepository,
        workflowRepository,
        gemtekResultQuery,
        smsGemtekSend,
        configService,
      ),
      update,
      workflowUpdates,
      gemtekResultQuery,
    };
  };

  it('(3,0) 확정은 SUCCEEDED 로 종결하고 쿠폰 전달완료를 표식한다', async () => {
    const reportTime = new Date('2026-07-27T11:00:00');
    const { service, update, workflowUpdates } = createService({
      tracking: [attempt()],
      resultByMseq: jest.fn().mockResolvedValue({ mseq: 1001, stat: '3', result: '0', sendTime: null, reportTime }),
    });

    const summary = await service.reconcileOnce(now);

    expect(summary.succeeded).toBe(1);
    expect(update.mock.calls[0][1]).toMatchObject({
      status: MessageAttemptStatus.SUCCEEDED,
      gemtekResult: '0',
      resolvedAt: reportTime,
    });
    expect(workflowUpdates[0].set).toMatchObject({
      deliveredFlag: true,
      deliveredChannel: MessageAttemptChannel.MMS,
      workflowStatus: DeliveryWorkflowStatus.COMPLETED,
    });
    // 종결·수동 종결 상태는 건드리지 않는다(RESOLVED_MANUALLY_* 불변 override).
    expect(workflowUpdates[0].where.join(' ')).toContain('workflow_status IN (:...open)');
  });

  it('520 등 확정 실패는 FAILED_FINAL 로 종결한다', async () => {
    const { service, update } = createService({
      tracking: [attempt()],
      resultByMseq: jest
        .fn()
        .mockResolvedValue({ mseq: 1001, stat: '3', result: '520', sendTime: null, reportTime: now }),
    });

    const summary = await service.reconcileOnce(now);

    expect(summary.failed).toBe(1);
    expect(update.mock.calls[0][1]).toMatchObject({ status: MessageAttemptStatus.FAILED_FINAL, gemtekResult: '520' });
  });

  it('504 는 자동 재발송이 비활성이면 예약하지 않고 FAILED_FINAL 로 종결한다(§10 2단계)', async () => {
    const { service, update } = createService({
      tracking: [attempt()],
      resultByMseq: jest
        .fn()
        .mockResolvedValue({ mseq: 1001, stat: '3', result: '504', sendTime: null, reportTime: now }),
    });

    const summary = await service.reconcileOnce(now);

    expect(summary.retryScheduled).toBe(0);
    expect(summary.failed).toBe(1);
    expect(update.mock.calls[0][1]).toMatchObject({ status: MessageAttemptStatus.FAILED_FINAL });
  });

  it('504 는 canary 활성 + 최초 시도일 때만 RETRY_SCHEDULED 로 예약한다', async () => {
    const reportTime = new Date('2026-07-27T22:30:00');
    const { service, update } = createService({
      auto504: true,
      tracking: [attempt()],
      resultByMseq: jest.fn().mockResolvedValue({ mseq: 1001, stat: '3', result: '504', sendTime: null, reportTime }),
    });

    const summary = await service.reconcileOnce(new Date('2026-07-27T22:35:00'));

    expect(summary.retryScheduled).toBe(1);
    const patch = update.mock.calls[0][1];
    expect(patch).toMatchObject({ status: MessageAttemptStatus.RETRY_SCHEDULED });
    // 심야 확정은 익일 08:00 으로 예약한다(§7.2).
    expect((patch.nextAttemptAt as Date).toISOString()).toBe(new Date('2026-07-28T08:00:00').toISOString());
  });

  it('재발송 자식의 504 는 canary 가 켜져 있어도 예약하지 않는다(무한 연쇄 차단)', async () => {
    const { service, update } = createService({
      auto504: true,
      tracking: [attempt({ retryOfAttemptId: 'b'.repeat(32), attemptType: MessageAttemptType.AUTO_504 })],
      resultByMseq: jest
        .fn()
        .mockResolvedValue({ mseq: 1001, stat: '3', result: '504', sendTime: null, reportTime: now }),
    });

    const summary = await service.reconcileOnce(now);

    expect(summary.retryScheduled).toBe(0);
    expect(update.mock.calls[0][1]).toMatchObject({ status: MessageAttemptStatus.FAILED_FINAL });
  });

  it('519·미분류 확정은 UNKNOWN 으로 남기고 운영 확인으로 승격한다', async () => {
    const { service, update, workflowUpdates } = createService({
      tracking: [attempt()],
      resultByMseq: jest
        .fn()
        .mockResolvedValue({ mseq: 1001, stat: '3', result: '519', sendTime: null, reportTime: now }),
    });

    const summary = await service.reconcileOnce(now);

    expect(summary.unknown).toBe(1);
    expect(update.mock.calls[0][1]).toMatchObject({ status: MessageAttemptStatus.UNKNOWN });
    expect(workflowUpdates[0].set).toMatchObject({ workflowStatus: DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED });
  });

  it('미확정(STAT≠3)은 상태를 바꾸지 않고 다음 사이클로 넘긴다(25시간 자동 성공 판정 없음)', async () => {
    const { service, update } = createService({
      tracking: [attempt()],
      resultByMseq: jest
        .fn()
        .mockResolvedValue({ mseq: 1001, stat: '1', result: null, sendTime: null, reportTime: null }),
    });

    const summary = await service.reconcileOnce(now);

    expect(summary.pending).toBe(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('결과가 아직 없으면 현재월을 다음 시작월로 남겨 증분 탐색을 이어간다', async () => {
    const findByMseq = jest.fn().mockResolvedValue(null);
    const { service, update } = createService({
      tracking: [attempt({ nextSearchMonth: '202606' })],
      resultByMseq: findByMseq,
    });

    await service.reconcileOnce(now);

    // 접수월(2026-06)부터 현재월(2026-07)까지만 훑는다.
    expect(findByMseq.mock.calls.map((c) => c[0])).toEqual(['202606', '202607']);
    expect(update.mock.calls[0][1]).toMatchObject({ lastSearchedMonth: '202607', nextSearchMonth: '202607' });
  });

  it('보존 한도(90일)를 넘기면 재조회를 멈추고 UNKNOWN + 운영 승격으로 종결한다', async () => {
    const { service, update, workflowUpdates, gemtekResultQuery } = createService({
      tracking: [attempt({ createdAt: new Date('2026-04-01T00:00:00') })],
    });

    const summary = await service.reconcileOnce(now);

    expect((gemtekResultQuery as never as { findByMseq: jest.Mock }).findByMseq).not.toHaveBeenCalled();
    expect(summary.unknown).toBe(1);
    expect(update.mock.calls[0][1]).toMatchObject({ status: MessageAttemptStatus.UNKNOWN });
    expect(workflowUpdates[0].set).toMatchObject({ workflowStatus: DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED });
  });

  it('재조정 중인 시도는 상관키로 큐를 조회해 MSEQ 를 복구하고 추적을 재개한다', async () => {
    const { service, update } = createService({
      reconciling: [attempt({ status: MessageAttemptStatus.RECONCILING, mseq: null })],
      queueMseq: jest.fn().mockResolvedValue(2002),
    });

    const summary = await service.reconcileOnce(now);

    expect(summary.recovered).toBe(1);
    expect(update.mock.calls[0][1]).toMatchObject({ status: MessageAttemptStatus.TRACKING, mseq: '2002' });
  });

  it('큐에 없으면 결과 파티션을 상관키로 훑어 복구한다(재삽입 금지)', async () => {
    const { service, update } = createService({
      reconciling: [attempt({ status: MessageAttemptStatus.RECONCILING, mseq: null })],
      queueMseq: jest.fn().mockResolvedValue(null),
      resultByAttemptId: jest
        .fn()
        .mockResolvedValue({ mseq: 3003, stat: '3', result: '0', sendTime: null, reportTime: now }),
    });

    const summary = await service.reconcileOnce(now);

    expect(summary.recovered).toBe(1);
    expect(update.mock.calls[0][1]).toMatchObject({ status: MessageAttemptStatus.TRACKING, mseq: '3003' });
  });

  it('상관키 조회가 0건이면 이 사이클에서 종결하지 않는다(SLA 초과 시에만 UNKNOWN)', async () => {
    const { service, update } = createService({
      reconciling: [attempt({ status: MessageAttemptStatus.RECONCILING, mseq: null })],
      queueMseq: jest.fn().mockResolvedValue(null),
      resultByAttemptId: jest.fn().mockResolvedValue(null),
    });

    const summary = await service.reconcileOnce(now);

    expect(summary.recovered).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('취소 의도를 가진 재조정 건은 여기서 복구하지 않는다(취소 재개는 CANCEL_INFLIGHT_SEND 소관)', async () => {
    const queueMseq = jest.fn().mockResolvedValue(2002);
    const { service, update } = createService({
      reconciling: [attempt({ status: MessageAttemptStatus.RECONCILING, mseq: null, cancelRequestedAt: new Date() })],
      queueMseq,
    });

    await service.reconcileOnce(now);

    expect(queueMseq).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
