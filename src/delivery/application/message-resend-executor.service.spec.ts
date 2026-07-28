import { MessageResendExecutorService } from './message-resend-executor.service';
import { MessageAttemptChannel, MessageAttemptStatus, MessageAttemptType } from '../interface/message.attempt.status';
import { DeliveryExclusiveOp, LEGACY_SEND_OP } from '../interface/delivery.workflow.status';

/**
 * 504 자동 재발송 실행기(§6.3 dueResend).
 * plans/프리미엄_발송실패_재발송_구상.md §4(체인당 1회) / §5.3(두 행 원자성) / §7.2(기한·시간대) /
 * §9(단일 동시성 모델) / §10 4단계(canary 플래그).
 */
describe('MessageResendExecutorService — 504 자동 재발송 실행(dueResend)', () => {
  // 허용 발송 시간대(08:00–20:00 KST) 안의 시각.
  const now = new Date('2026-07-27T12:00:00');

  const scheduled = (override: Partial<Record<string, unknown>> = {}) =>
    ({
      attemptId: 'a'.repeat(32),
      orderDeliveryId: 500,
      channel: MessageAttemptChannel.MMS,
      attemptType: MessageAttemptType.INITIAL,
      attemptSeq: 1,
      retryOfAttemptId: null,
      rootAttemptId: 'a'.repeat(32),
      status: MessageAttemptStatus.RETRY_SCHEDULED,
      nextAttemptAt: new Date('2026-07-27T11:00:00'),
      retryDeadlineAt: new Date('2026-07-28T10:00:00'),
      cancelRequestedAt: null,
      stateEnteredAt: new Date('2026-07-27T10:00:00'),
      ...override,
    }) as never;

  const createService = (options: {
    auto504?: boolean;
    due?: unknown[];
    stuck?: unknown[];
    workflow?: Partial<Record<string, unknown>>;
    orderDelivery?: Partial<Record<string, unknown>> | null;
    claimAffected?: number;
    retiredAffected?: number;
    slotAcquired?: boolean;
    dispatch?: jest.Mock;
    trackPreparedSend?: jest.Mock;
  }) => {
    const attemptUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    const attemptRepository = {
      find: jest
        .fn()
        .mockImplementationOnce(async () => options.due ?? [])
        .mockImplementationOnce(async () => options.stuck ?? [])
        .mockImplementation(async () => []),
      update: attemptUpdate,
    } as never;

    const claimConditions: { sql: string; params?: Record<string, unknown> }[] = [];
    const claimSet: Record<string, unknown>[] = [];
    const odUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    const orderDeliveryRepository = {
      findOne: jest.fn().mockResolvedValue(
        options.orderDelivery === null
          ? null
          : {
              id: 500,
              deletedAt: null,
              couponStatus: null,
              refundedAt: null,
              refundStatus: null,
              ...(options.orderDelivery ?? {}),
            },
      ),
      update: odUpdate,
      createQueryBuilder: jest.fn().mockImplementation(() => {
        const qb: Record<string, unknown> = {
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
            claimSet.push(values);
            return qb;
          }),
          where: jest.fn().mockImplementation((sql: string, params?: Record<string, unknown>) => {
            claimConditions.push({ sql, params });
            return qb;
          }),
          andWhere: jest.fn().mockImplementation((sql: string, params?: Record<string, unknown>) => {
            claimConditions.push({ sql, params });
            return qb;
          }),
          execute: jest.fn().mockResolvedValue({ affected: options.claimAffected ?? 1 }),
        };
        return qb;
      }),
    } as never;

    const workflow = {
      orderDeliveryId: 500,
      workflowVersion: '3',
      cutoverMigratedAt: null,
      deliveredFlag: false,
      ...(options.workflow ?? {}),
    };
    const slot = {
      orderDeliveryId: 500,
      op: DeliveryExclusiveOp.RETRY,
      ownerToken: 'token-1',
      workflowVersion: '4',
      leaseExpiresAt: new Date(now.getTime() + 300000),
    };
    const slotService = {
      ensureWorkflow: jest.fn().mockResolvedValue(workflow),
      acquire: jest.fn().mockResolvedValue(
        (options.slotAcquired ?? true)
          ? { acquired: true, slot }
          : { acquired: false, code: 'DELIVERY_OPERATION_LOCKED' },
      ),
      release: jest.fn().mockResolvedValue(true),
    };

    const trackPreparedSend = options.trackPreparedSend ?? jest.fn().mockResolvedValue(true);
    const messageAttemptService = { trackPreparedSend } as never;

    const markWorkflowFailedIfSettled = jest.fn().mockResolvedValue(undefined);
    const reconcileService = { markWorkflowFailedIfSettled } as never;

    const dispatch = options.dispatch ?? jest.fn().mockResolvedValue({ mseq: 900, recovered: false });
    const prepareCouponResendDispatch = jest.fn().mockResolvedValue(dispatch);
    const deliveryBatchService = { prepareCouponResendDispatch } as never;

    const configService = {
      get: jest
        .fn()
        .mockImplementation((key: string) =>
          key === 'DELIVERY_AUTO_RESEND_504_ENABLED' ? ((options.auto504 ?? true) ? 'true' : 'false') : undefined,
        ),
    } as never;

    const txSaved: Record<string, unknown>[] = [];
    const txUpdate = jest.fn().mockResolvedValue({ affected: options.retiredAffected ?? 1 });
    const txRepo = {
      update: txUpdate,
      create: jest.fn().mockImplementation((v: Record<string, unknown>) => v),
      save: jest.fn().mockImplementation(async (v: Record<string, unknown>) => {
        txSaved.push(v);
        return v;
      }),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => Promise<unknown>) =>
        cb({ getRepository: () => txRepo }),
      ),
    } as never;

    return {
      service: new MessageResendExecutorService(
        attemptRepository,
        orderDeliveryRepository,
        slotService as never,
        messageAttemptService,
        reconcileService,
        deliveryBatchService,
        configService,
        dataSource,
      ),
      attemptRepository,
      attemptUpdate,
      odUpdate,
      claimConditions,
      claimSet,
      slotService,
      trackPreparedSend,
      markWorkflowFailedIfSettled,
      prepareCouponResendDispatch,
      dispatch,
      txUpdate,
      txSaved,
      dataSource,
    };
  };

  it('canary 플래그가 꺼져 있으면 아무것도 조회·실행하지 않는다(§10 4단계)', async () => {
    const { service, attemptRepository } = createService({ auto504: false, due: [scheduled()] });

    const summary = await service.runDueResendOnce(now);

    expect(summary.scanned).toBe(0);
    expect((attemptRepository as { find: jest.Mock }).find).not.toHaveBeenCalled();
  });

  it('허용 발송 시간대(08–20 KST) 밖에서는 실행하지 않는다(§7.2) — 예약은 버리지 않고 다음 창으로 미룬다', async () => {
    const { service, attemptRepository } = createService({ due: [scheduled()] });

    const summary = await service.runDueResendOnce(new Date('2026-07-27T21:30:00'));

    expect(summary.scanned).toBe(0);
    expect((attemptRepository as { find: jest.Mock }).find).not.toHaveBeenCalled();
  });

  it('실행 시점에 기한(retry_deadline_at)을 넘겼으면 재발송 없이 FAILED_FINAL 로 종결한다(§7.2)', async () => {
    const { service, attemptUpdate, trackPreparedSend, markWorkflowFailedIfSettled } = createService({
      due: [scheduled({ retryDeadlineAt: new Date('2026-07-27T11:59:59') })],
    });

    const summary = await service.runDueResendOnce(now);

    expect(summary.expired).toBe(1);
    expect(attemptUpdate).toHaveBeenCalledWith(
      { attemptId: 'a'.repeat(32), status: MessageAttemptStatus.RETRY_SCHEDULED },
      expect.objectContaining({ status: MessageAttemptStatus.FAILED_FINAL }),
    );
    expect(markWorkflowFailedIfSettled).toHaveBeenCalledWith(500, now);
    expect(trackPreparedSend).not.toHaveBeenCalled();
  });

  it('타 채널 전달 완료(deliveredFlag) 건은 CANCELLED_SUPERSEDED 로 종결하고 재발송하지 않는다(§3 나)', async () => {
    const { service, attemptUpdate, trackPreparedSend } = createService({
      due: [scheduled()],
      workflow: { deliveredFlag: true },
    });

    const summary = await service.runDueResendOnce(now);

    expect(summary.superseded).toBe(1);
    expect(attemptUpdate).toHaveBeenCalledWith(
      { attemptId: 'a'.repeat(32), status: MessageAttemptStatus.RETRY_SCHEDULED },
      expect.objectContaining({ status: MessageAttemptStatus.CANCELLED_SUPERSEDED }),
    );
    expect(trackPreparedSend).not.toHaveBeenCalled();
  });

  describe('미전환(legacy) 건 — 기존 claimedAt/mutationClaimedAt 모델로만 직렬화(§9)', () => {
    it('정상 실행: claim CAS → 원 시도 RETRIED + AUTO_504 자식 생성(한 트랜잭션) → commit 후 발송 → 해제', async () => {
      const { service, claimSet, claimConditions, txUpdate, txSaved, trackPreparedSend, odUpdate } = createService({
        due: [scheduled()],
      });

      const summary = await service.runDueResendOnce(now);

      expect(summary.resent).toBe(1);

      // legacy claim: 두 토큰을 같은 값으로 원자 획득 + 죽은 핀·환불·삭제 가드 포함.
      expect(claimSet[0].claimedAt).toBeInstanceOf(Date);
      expect(claimSet[0].mutationClaimedAt).toBe(claimSet[0].claimedAt);
      const sqls = claimConditions.map((c) => c.sql).join('\n');
      expect(sqls).toContain('coupon_status NOT IN');
      expect(sqls).toContain('refunded_at IS NULL');
      expect(sqls).toContain('deleted_at IS NULL');

      // 같은 트랜잭션: 원 시도 RETRY_SCHEDULED→RETRIED CAS + 자식 생성.
      expect(txUpdate).toHaveBeenCalledWith(
        { attemptId: 'a'.repeat(32), status: MessageAttemptStatus.RETRY_SCHEDULED },
        expect.objectContaining({ status: MessageAttemptStatus.RETRIED }),
      );
      expect(txSaved).toHaveLength(1);
      expect(txSaved[0]).toMatchObject({
        attemptType: MessageAttemptType.AUTO_504,
        retryOfAttemptId: 'a'.repeat(32),
        rootAttemptId: 'a'.repeat(32),
        attemptSeq: 2,
        status: MessageAttemptStatus.OUTBOX_READY,
        channel: MessageAttemptChannel.MMS,
        // legacy 건을 RETRY 로 기록하면 §10 불변식 ② 가 legacy 정상 동작을 위반으로 집계한다.
        createdByOp: LEGACY_SEND_OP,
        // 크래시 후 재개에도 기한 판정이 유지되도록 원 시도 기한을 상속한다(§7.2).
        retryDeadlineAt: new Date('2026-07-28T10:00:00'),
      });

      // commit 후 외부 호출(자식 attempt 로).
      expect(trackPreparedSend).toHaveBeenCalledTimes(1);
      expect(trackPreparedSend.mock.calls[0][0]).toMatchObject({ attemptType: MessageAttemptType.AUTO_504 });

      // 해제는 자기 토큰으로만, claimedAt 과 변형 lease 를 별개 문장으로.
      expect(odUpdate).toHaveBeenCalledWith({ id: 500, claimedAt: claimSet[0].claimedAt }, { claimedAt: null });
      expect(odUpdate).toHaveBeenCalledWith(
        { id: 500, mutationClaimedAt: claimSet[0].claimedAt },
        { mutationClaimedAt: null },
      );
    });

    it('claim 경합(affected=0)이면 상태를 건드리지 않고 skip 한다', async () => {
      const { service, txUpdate, trackPreparedSend } = createService({ due: [scheduled()], claimAffected: 0 });

      const summary = await service.runDueResendOnce(now);

      expect(summary.skipped).toBe(1);
      expect(txUpdate).not.toHaveBeenCalled();
      expect(trackPreparedSend).not.toHaveBeenCalled();
    });

    it('원 시도 CAS 경합(affected=0)이면 자식을 만들지 않고 발송하지 않는다 — 같은 예약 이중 실행 차단', async () => {
      const { service, txSaved, trackPreparedSend } = createService({ due: [scheduled()], retiredAffected: 0 });

      const summary = await service.runDueResendOnce(now);

      expect(summary.skipped).toBe(1);
      expect(txSaved).toHaveLength(0);
      expect(trackPreparedSend).not.toHaveBeenCalled();
    });

    it('폐기·환불된 쿠폰은 재발송하지 않는다(죽은 핀 배달 방지) — 예약 종결은 기한 sweep 에 맡긴다', async () => {
      const { service, txUpdate, trackPreparedSend, prepareCouponResendDispatch } = createService({
        due: [scheduled()],
        orderDelivery: { refundedAt: new Date() },
      });

      const summary = await service.runDueResendOnce(now);

      expect(summary.skipped).toBe(1);
      expect(prepareCouponResendDispatch).not.toHaveBeenCalled();
      expect(txUpdate).not.toHaveBeenCalled();
      expect(trackPreparedSend).not.toHaveBeenCalled();
    });

    it('발송 실패(외부 예외)여도 게이트는 해제된다', async () => {
      const trackPreparedSend = jest.fn().mockRejectedValue(new Error('gemtek down'));
      const { service, odUpdate, claimSet } = createService({ due: [scheduled()], trackPreparedSend });

      const summary = await service.runDueResendOnce(now);

      expect(summary.skipped).toBe(1);
      expect(odUpdate).toHaveBeenCalledWith({ id: 500, claimedAt: claimSet[0].claimedAt }, { claimedAt: null });
    });
  });

  describe('전환(cutover) 건 — Level A RETRY 슬롯으로만 직렬화(§6.1 표 2-1)', () => {
    const cutover = { cutoverMigratedAt: new Date('2026-07-01T00:00:00') };

    it('RETRY 슬롯을 점유하고 자식 생성 출처를 RETRY 로 기록하며, 끝나면 슬롯을 해제한다', async () => {
      const { service, slotService, txSaved, claimSet } = createService({ due: [scheduled()], workflow: cutover });

      const summary = await service.runDueResendOnce(now);

      expect(summary.resent).toBe(1);
      expect(slotService.acquire).toHaveBeenCalledWith(
        expect.objectContaining({ orderDeliveryId: 500, op: DeliveryExclusiveOp.RETRY }),
      );
      expect(slotService.release).toHaveBeenCalledTimes(1);
      // legacy claim 은 잡지 않는다(두 동시성 모델을 겹치지 않는다, §9).
      expect(claimSet).toHaveLength(0);
      expect(txSaved[0]).toMatchObject({
        createdByOp: DeliveryExclusiveOp.RETRY,
        ownerToken: 'token-1',
        createdWorkflowVersion: '4',
      });
    });

    it('슬롯 점유 실패면 skip 하고 다음 사이클에 재시도한다', async () => {
      const { service, txUpdate, trackPreparedSend } = createService({
        due: [scheduled()],
        workflow: cutover,
        slotAcquired: false,
      });

      const summary = await service.runDueResendOnce(now);

      expect(summary.skipped).toBe(1);
      expect(txUpdate).not.toHaveBeenCalled();
      expect(trackPreparedSend).not.toHaveBeenCalled();
    });
  });

  describe('OUTBOX_READY 정체 자식 재개(§5.3 — 외부 호출 전 확정, 동일 attemptId 최초 insert 재개)', () => {
    const stuckChild = () =>
      scheduled({
        attemptId: 'b'.repeat(32),
        attemptType: MessageAttemptType.AUTO_504,
        retryOfAttemptId: 'a'.repeat(32),
        status: MessageAttemptStatus.OUTBOX_READY,
        attemptSeq: 2,
      });

    it('신규 행을 만들지 않고 그 행으로 발송을 재개한다', async () => {
      const { service, txSaved, trackPreparedSend } = createService({ stuck: [stuckChild()] });

      const summary = await service.runDueResendOnce(now);

      expect(summary.resumed).toBe(1);
      expect(txSaved).toHaveLength(0);
      expect(trackPreparedSend).toHaveBeenCalledTimes(1);
      expect(trackPreparedSend.mock.calls[0][0]).toMatchObject({ attemptId: 'b'.repeat(32) });
    });

    it('전환 건의 재개는 컷오버 슬라이스 도입 전까지 수행하지 않는다', async () => {
      const { service, trackPreparedSend } = createService({
        stuck: [stuckChild()],
        workflow: { cutoverMigratedAt: new Date('2026-07-01T00:00:00') },
      });

      const summary = await service.runDueResendOnce(now);

      expect(summary.skipped).toBe(1);
      expect(trackPreparedSend).not.toHaveBeenCalled();
    });

    it('재개 대상도 기한을 넘겼으면 발송 없이 FAILED_FINAL 로 종결한다(상속된 기한, §7.2)', async () => {
      const { service, attemptUpdate, trackPreparedSend } = createService({
        stuck: [stuckChild()],
      });

      const summary = await service.runDueResendOnce(new Date('2026-07-28T10:00:01'));

      expect(summary.expired).toBe(1);
      expect(attemptUpdate).toHaveBeenCalledWith(
        { attemptId: 'b'.repeat(32), status: MessageAttemptStatus.OUTBOX_READY },
        expect.objectContaining({ status: MessageAttemptStatus.FAILED_FINAL }),
      );
      expect(trackPreparedSend).not.toHaveBeenCalled();
    });
  });
});
