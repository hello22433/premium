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
    unknown?: unknown[];
    expiredResend?: unknown[];
    resultByMseq?: jest.Mock;
    resultByAttemptId?: jest.Mock;
    queueMseq?: jest.Mock;
    auto504?: boolean;
    pendingCount?: number;
    alimTalkAttempt?: unknown;
  }) => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const attemptQueries: { sql: string; params: Record<string, unknown> }[] = [];
    const workflowUpdates: { set: Record<string, unknown>; where: string[] }[] = [];

    const attemptRepository = {
      find: jest
        .fn()
        .mockImplementationOnce(async () => options.tracking ?? [])
        .mockImplementationOnce(async () => options.reconciling ?? [])
        .mockImplementationOnce(async () => options.unknown ?? [])
        .mockImplementation(async () => []),
      update,
      findOne: jest.fn().mockImplementation(async () => options.alimTalkAttempt ?? null),
      count: jest.fn().mockResolvedValue(options.pendingCount ?? 0),
      createQueryBuilder: jest.fn().mockImplementation(() => {
        const qb: Record<string, unknown> = {
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockImplementation((sql: string, params: Record<string, unknown>) => {
            attemptQueries.push({ sql, params });
            return qb;
          }),
          andWhere: jest.fn().mockImplementation((sql: string, params: Record<string, unknown>) => {
            attemptQueries.push({ sql, params });
            return qb;
          }),
          take: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockImplementation(async () => options.expiredResend ?? []),
          execute: jest.fn().mockResolvedValue({ affected: 0 }),
        };
        return qb;
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

    // 전달완료 표식은 슬롯 서비스가 단일 소유한다(알림톡 확정 경로와 같은 전이를 쓰기 위함).
    const markDelivered = jest.fn().mockResolvedValue(true);
    const slotService = { markDelivered } as never;

    return {
      service: new MessageResultReconcileService(
        attemptRepository,
        workflowRepository,
        gemtekResultQuery,
        smsGemtekSend,
        configService,
        slotService,
      ),
      update,
      workflowUpdates,
      attemptQueries,
      gemtekResultQuery,
      markDelivered,
    };
  };

  it('(3,0) 확정은 SUCCEEDED 로 종결하고 쿠폰 전달완료를 표식한다', async () => {
    const reportTime = new Date('2026-07-27T11:00:00');
    const { service, update, markDelivered } = createService({
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
    expect(markDelivered).toHaveBeenCalledWith(500, MessageAttemptChannel.MMS, reportTime);
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
  describe('UNKNOWN 승격 후에도 보존 한도까지 조회한다 (§7.1·§7.3)', () => {
    it('지연 확정 결과가 도착해도 자동 종결하지 않고 LATE_RESULT_REVIEW 로 기록만 한다', async () => {
      const reportTime = new Date('2026-07-27T11:30:00');
      const { service, update, workflowUpdates } = createService({
        unknown: [attempt({ status: MessageAttemptStatus.UNKNOWN })],
        resultByMseq: jest.fn().mockResolvedValue({ mseq: 1001, stat: '3', result: '0', sendTime: null, reportTime }),
      });

      const summary = await service.reconcileOnce(now);

      expect(summary.lateResult).toBe(1);
      // 상태는 UNKNOWN 을 유지한다 — 늦게 온 성공으로 자동 정정하지 않는다.
      const [criteria, patch] = update.mock.calls[0];
      expect(criteria).toMatchObject({ status: MessageAttemptStatus.UNKNOWN });
      expect(patch).toMatchObject({ gemtekResult: '0', lateResultAt: now });
      expect(patch).not.toHaveProperty('status');
      expect(workflowUpdates[0].set).toMatchObject({
        workflowStatus: DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
        opsReviewReason: 'LATE_RESULT_REVIEW',
      });
    });

    it('아직 확정 전이면 커서만 전진시키고 다음 사이클에 다시 본다(조회 중단 없음)', async () => {
      const findByMseq = jest.fn().mockResolvedValue(null);
      const { service, update } = createService({
        unknown: [attempt({ status: MessageAttemptStatus.UNKNOWN, nextSearchMonth: '202606' })],
        resultByMseq: findByMseq,
      });

      const summary = await service.reconcileOnce(now);

      expect(findByMseq.mock.calls.map((c) => c[0])).toEqual(['202606', '202607']);
      expect(summary.lateResult).toBe(0);
      expect(update.mock.calls[0][1]).toMatchObject({ lastSearchedMonth: '202607', nextSearchMonth: '202607' });
    });

    it('MSEQ 없이 승격된 UNKNOWN 은 상관키(EXT_COL2)로 결과를 찾고 MSEQ 도 함께 남긴다', async () => {
      const reportTime = new Date('2026-07-27T11:00:00');
      const findByMseq = jest.fn();
      const findByAttemptId = jest
        .fn()
        .mockResolvedValue({ mseq: 4004, stat: '3', result: '504', sendTime: null, reportTime });
      const { service, update, workflowUpdates } = createService({
        unknown: [attempt({ status: MessageAttemptStatus.UNKNOWN, mseq: null })],
        resultByMseq: findByMseq,
        resultByAttemptId: findByAttemptId,
      });

      const summary = await service.reconcileOnce(now);

      // MSEQ 가 없으면 MSEQ 조회로는 영원히 못 찾는다 — 상관키 조회로 갈라져야 한다.
      expect(findByMseq).not.toHaveBeenCalled();
      expect(findByAttemptId).toHaveBeenCalledWith('202607', 'a'.repeat(32));
      expect(summary.lateResult).toBe(1);
      const [criteria, patch] = update.mock.calls[0];
      expect(criteria).toMatchObject({ status: MessageAttemptStatus.UNKNOWN });
      expect(patch).toMatchObject({ mseq: '4004', gemtekResult: '504', lateResultAt: now });
      expect(patch).not.toHaveProperty('status');
      expect(workflowUpdates[0].set).toMatchObject({ opsReviewReason: 'LATE_RESULT_REVIEW' });
    });

    it('MSEQ 없는 UNKNOWN 이 상관키로도 안 잡히면 커서만 전진시키고 계속 본다', async () => {
      const findByAttemptId = jest.fn().mockResolvedValue(null);
      const { service, update } = createService({
        unknown: [attempt({ status: MessageAttemptStatus.UNKNOWN, mseq: null, nextSearchMonth: '202606' })],
        resultByAttemptId: findByAttemptId,
      });
      const summary = await service.reconcileOnce(now);

      expect(findByAttemptId.mock.calls.map((c) => c[0])).toEqual(['202606', '202607']);
      expect(summary.lateResult).toBe(0);
      expect(update.mock.calls[0][1]).toMatchObject({ lastSearchedMonth: '202607', nextSearchMonth: '202607' });
    });

    it('보존 한도(90일)를 넘긴 UNKNOWN 은 조회하지 않는다', async () => {
      const findByMseq = jest.fn();
      const { service, update } = createService({
        unknown: [attempt({ status: MessageAttemptStatus.UNKNOWN, createdAt: new Date('2026-04-01T00:00:00') })],
        resultByMseq: findByMseq,
      });

      const summary = await service.reconcileOnce(now);

      expect(findByMseq).not.toHaveBeenCalled();
      expect(summary.lateResult).toBe(0);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('예약 재발송 만료 판정 (§7.2)', () => {
    it('만료는 next_attempt_at 이 아니라 retry_deadline_at(=확정+24h) 기준이다', async () => {
      const { service, attemptQueries } = createService({ expiredResend: [] });

      await service.sweepSlaOnce(now);

      const expiredCondition = attemptQueries.find((q) => q.sql.includes('retry_deadline_at'));
      expect(expiredCondition).toBeDefined();
      expect(expiredCondition!.sql).toContain('ma.retry_deadline_at < :now');
      // 기한 컬럼이 없는 과거 행만 next_attempt_at + 24h 로 보수 만료시킨다.
      expect(expiredCondition!.sql).toContain('ma.retry_deadline_at IS NULL');
      expect((expiredCondition!.params.legacyCutoff as Date).getTime()).toBe(now.getTime() - 24 * 60 * 60 * 1000);
    });

    it('기한을 넘긴 예약은 FAILED_FINAL 로 종결한다', async () => {
      const { service, update } = createService({
        expiredResend: [attempt({ status: MessageAttemptStatus.RETRY_SCHEDULED })],
      });

      const summary = await service.sweepSlaOnce(now);

      expect(summary.expiredResend).toBe(1);
      expect(update.mock.calls[0][0]).toMatchObject({ status: MessageAttemptStatus.RETRY_SCHEDULED });
      expect(update.mock.calls[0][1]).toMatchObject({ status: MessageAttemptStatus.FAILED_FINAL });
    });

    it('504 예약 시 확정 시각 기준 기한을 함께 저장한다', async () => {
      const reportTime = new Date('2026-07-27T22:30:00');
      const { service, update } = createService({
        auto504: true,
        tracking: [attempt()],
        resultByMseq: jest.fn().mockResolvedValue({ mseq: 1001, stat: '3', result: '504', sendTime: null, reportTime }),
      });

      await service.reconcileOnce(new Date('2026-07-27T22:35:00'));

      const patch = update.mock.calls[0][1];
      expect(patch.retryDeadlineAt.toISOString()).toBe(new Date('2026-07-28T22:30:00').toISOString());
      // 예약 시각(익일 08:00)이 기한(익일 22:30)보다 앞선다 — 창 안에서만 실행된다.
      expect(patch.nextAttemptAt.getTime()).toBeLessThan(patch.retryDeadlineAt.getTime());
    });
  });
  /**
   * 알림톡 시도는 MSEQ 가 없어 reconcileOnce 대상이 아니다(`mseq: Not(IsNull())`).
   * reportSweep 가 닫아주지 않으면 성공한 발송이 SLA 초과로 UNKNOWN + OPS_REVIEW_REQUIRED 가 된다.
   */
  describe('settleAlimTalkReport — 알림톡 확정 반영 (§3 나)', () => {
    const alimTalk = (override: Partial<Record<string, unknown>> = {}) =>
      attempt({ channel: MessageAttemptChannel.ALIM_TALK, mseq: null, ...override });

    it('수신확정은 SUCCEEDED 로 종결하고 전달완료를 표식한다', async () => {
      const { service, update, markDelivered } = createService({ alimTalkAttempt: alimTalk() });

      const settled = await service.settleAlimTalkReport(500, true, now);

      expect(settled).toBe(true);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ status: MessageAttemptStatus.TRACKING }),
        expect.objectContaining({ status: MessageAttemptStatus.SUCCEEDED, resolvedAt: now }),
      );
      expect(markDelivered).toHaveBeenCalledWith(500, MessageAttemptChannel.ALIM_TALK, now);
    });

    it('R1 미확정 종결은 FAILED_FINAL 로 닫고 전달완료를 표식하지 않는다', async () => {
      const { service, update, markDelivered } = createService({ alimTalkAttempt: alimTalk() });

      const settled = await service.settleAlimTalkReport(500, false, now);

      expect(settled).toBe(true);
      expect(update.mock.calls[0][1]).toMatchObject({ status: MessageAttemptStatus.FAILED_FINAL });
      expect(markDelivered).not.toHaveBeenCalled();
    });

    it('TRACKING 알림톡 시도가 없으면 아무것도 하지 않는다(중복 호출 무해)', async () => {
      const { service, update, markDelivered } = createService({});

      expect(await service.settleAlimTalkReport(500, true, now)).toBe(false);
      expect(update).not.toHaveBeenCalled();
      expect(markDelivered).not.toHaveBeenCalled();
    });

    it('상태 전이가 경쟁에 밀리면(affected=0) 전달완료를 표식하지 않는다', async () => {
      const { service, markDelivered, update } = createService({ alimTalkAttempt: alimTalk() });
      update.mockResolvedValueOnce({ affected: 0 });

      expect(await service.settleAlimTalkReport(500, true, now)).toBe(false);
      expect(markDelivered).not.toHaveBeenCalled();
    });
  });
});
