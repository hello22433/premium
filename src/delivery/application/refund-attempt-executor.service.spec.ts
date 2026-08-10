import { ConflictException } from '@nestjs/common';
import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import { RefundAttemptEntity } from '../../entity/refund.attempt.entity';
import { StaleExternalResponseEntity, StaleMismatchReason } from '../../entity/stale.external.response.entity';
import { DeliveryExclusiveOp, DeliveryWorkflowStatus, OpsReviewReason } from '../interface/delivery.workflow.status';
import { RefundAttemptStatus, RefundEntryPath, RefundScope } from '../interface/refund.attempt.status';
import {
  REFUND_EXECUTION_TIMEOUT_MS,
  REFUND_EXECUTION_TIMEOUT_REASON,
  RefundAttemptExecutorService,
} from './refund-attempt-executor.service';

const now = new Date('2026-07-29T00:00:00.000Z');

function claimedRefund() {
  const attempt = Object.assign(new RefundAttemptEntity(), {
    id: '91',
    orderDeliveryId: 7,
    status: RefundAttemptStatus.CLAIMED,
    entryPath: RefundEntryPath.B,
    amount: 5000,
    scope: RefundScope.FULL,
    externalIdempotencyKey: 'refund:7:1',
    ownerToken: 'owner-1',
    generation: '3',
    workflowVersion: '12',
  });
  return {
    attempt,
    entryPath: RefundEntryPath.B,
    slot: {
      orderDeliveryId: 7,
      op: DeliveryExclusiveOp.REFUND,
      ownerToken: 'owner-1',
      workflowVersion: '12',
      leaseExpiresAt: new Date('2026-07-29T00:05:00.000Z'),
    },
  };
}

function makeSut() {
  const slotService = { heartbeat: jest.fn().mockResolvedValue(true) };
  const cryptoCipher = { encryptJson: jest.fn().mockReturnValue('v2:encrypted') };
  const sut = new RefundAttemptExecutorService({} as any, slotService as any, {} as any, cryptoCipher as any);
  const claim = jest.spyOn(sut as any, 'claim').mockResolvedValue(claimedRefund());
  const markSubmitting = jest.spyOn(sut as any, 'markSubmitting').mockResolvedValue(true);
  const settle = jest.spyOn(sut as any, 'settle').mockResolvedValue(true);
  const recordStaleAndReconcile = jest.spyOn(sut as any, 'recordStaleAndReconcile').mockResolvedValue(undefined);
  const markExecutionQuiesced = jest.spyOn(sut as any, 'markExecutionQuiesced').mockResolvedValue(undefined);
  return {
    sut,
    slotService,
    cryptoCipher,
    claim,
    markSubmitting,
    settle,
    recordStaleAndReconcile,
    markExecutionQuiesced,
  };
}

const baseInput = {
  orderDeliveryId: 7,
  amount: 5000,
  scope: RefundScope.FULL,
  externalIdempotencyKey: 'refund:7:1',
  now,
};

describe('RefundAttemptExecutorService', () => {
  it('CLAIMED를 durable하게 만든 뒤 SUBMITTING에서 외부 환불을 실행하고 성공을 반영한다', async () => {
    const { sut, markSubmitting, settle, slotService } = makeSut();
    const execute = jest.fn().mockResolvedValue({ status: RefundAttemptStatus.SUCCEEDED });

    const result = await sut.execute({ ...baseInput, execute });

    expect(markSubmitting.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
    expect(execute).toHaveBeenCalledWith({
      refundAttemptId: '91',
      ownerToken: 'owner-1',
      generation: '3',
      workflowVersion: '12',
      externalIdempotencyKey: 'refund:7:1',
    });
    expect(slotService.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ ownerToken: 'owner-1' }));
    // 콜백이 반환으로 끝났으므로 정지 사실을 같은 트랜잭션에서 남긴다(마지막 인자).
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: expect.objectContaining({ id: '91' }) }),
      { status: RefundAttemptStatus.SUCCEEDED },
      expect.any(Date),
      true,
    );
    expect(result).toEqual({ attemptId: '91', status: RefundAttemptStatus.SUCCEEDED });
  });

  it('외부 호출 예외는 재환불 가능한 FAILED로 단정하지 않고 UNKNOWN으로 종결한다', async () => {
    const { sut, settle } = makeSut();

    const result = await sut.execute({
      ...baseInput,
      execute: jest.fn().mockRejectedValue(new Error('socket closed after submit')),
    });

    expect(settle).toHaveBeenCalledWith(
      expect.anything(),
      {
        status: RefundAttemptStatus.UNKNOWN,
        reason: 'REFUND_EXECUTION_RESULT_UNKNOWN',
      },
      expect.any(Date),
      // 예외로 끝난 콜백도 끝난 것이다 — 정지 사실을 같은 트랜잭션에서 남긴다.
      true,
    );
    expect(result).toEqual({
      attemptId: '91',
      status: RefundAttemptStatus.UNKNOWN,
      reason: 'REFUND_EXECUTION_RESULT_UNKNOWN',
    });
  });
  it('callback이 직접 반환한 FAILED reason을 executor 결과에 보존한다', async () => {
    const { sut } = makeSut();

    const result = await sut.execute({
      ...baseInput,
      execute: jest.fn().mockResolvedValue({
        status: RefundAttemptStatus.FAILED,
        reason: 'PIN_REFUND_BINDING_MISMATCH',
      }),
    });

    expect(result).toEqual({
      attemptId: '91',
      status: RefundAttemptStatus.FAILED,
      reason: 'PIN_REFUND_BINDING_MISMATCH',
    });
  });

  it('콜백이 timeout 과 같은 메시지로 실패해도 timeout 으로 오인하지 않는다', async () => {
    // 콜백의 오류 메시지는 우리가 통제하지 못한다. 문자열로 판별하면 이미 끝난 콜백을
    // in-flight 로 오인해 정상 실패까지 재조정·SLA 수동종결로 밀린다.
    const { sut, settle } = makeSut();

    const result = await sut.execute({
      ...baseInput,
      execute: jest.fn().mockRejectedValue(new Error(REFUND_EXECUTION_TIMEOUT_REASON)),
    });

    expect(result).toEqual({
      attemptId: '91',
      status: RefundAttemptStatus.UNKNOWN,
      reason: 'REFUND_EXECUTION_RESULT_UNKNOWN',
    });
    expect(settle).toHaveBeenCalledWith(
      expect.anything(),
      { status: RefundAttemptStatus.UNKNOWN, reason: 'REFUND_EXECUTION_RESULT_UNKNOWN' },
      expect.any(Date),
      true,
    );
  });

  it('SUBMITTING 3중 fencing을 잃은 stale worker는 외부 환불을 호출하지 않는다', async () => {
    const { sut, markSubmitting, recordStaleAndReconcile } = makeSut();
    markSubmitting.mockResolvedValue(false);
    const execute = jest.fn();

    await expect(sut.execute({ ...baseInput, execute })).rejects.toBeInstanceOf(ConflictException);

    expect(execute).not.toHaveBeenCalled();
    expect(recordStaleAndReconcile).not.toHaveBeenCalled();
  });

  it('heartbeat가 false면 응답을 직접 settle하지 않고 stale 감사·재조정 경로로 보낸다', async () => {
    const { sut, slotService, settle, recordStaleAndReconcile } = makeSut();
    slotService.heartbeat.mockResolvedValue(false);
    const outcome = { status: RefundAttemptStatus.SUCCEEDED } as const;

    await expect(sut.execute({ ...baseInput, execute: jest.fn().mockResolvedValue(outcome) })).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(settle).not.toHaveBeenCalled();
    // heartbeat 소유권 상실은 mismatchReason 판정을 위해 heartbeatError=true 로 전달된다.
    expect(recordStaleAndReconcile).toHaveBeenCalledWith(expect.anything(), outcome, expect.any(Date), true, true);
  });

  it('heartbeat 예외도 소유권 상실로 latch하여 stale 처리한다', async () => {
    const { sut, slotService, settle, recordStaleAndReconcile } = makeSut();
    slotService.heartbeat.mockRejectedValue(new Error('db unavailable'));

    await expect(
      sut.execute({
        ...baseInput,
        execute: jest.fn().mockResolvedValue({ status: RefundAttemptStatus.SUCCEEDED }),
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(settle).not.toHaveBeenCalled();
    expect(recordStaleAndReconcile).toHaveBeenCalled();
  });

  it('settle fencing이 어긋나면 stale 응답을 기록하고 재조정 전이를 시도한다', async () => {
    const { sut, settle, recordStaleAndReconcile } = makeSut();
    settle.mockResolvedValue(false);

    await expect(
      sut.execute({
        ...baseInput,
        execute: jest.fn().mockResolvedValue({ status: RefundAttemptStatus.SUCCEEDED }),
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(recordStaleAndReconcile).toHaveBeenCalledWith(
      expect.anything(),
      { status: RefundAttemptStatus.SUCCEEDED },
      expect.any(Date),
      true,
    );
  });

  it('응답 없는 외부 콜백은 hard timeout 으로 UNKNOWN 종결하되 정지 사실은 남기지 않는다', async () => {
    jest.useFakeTimers();
    const { sut, settle, markExecutionQuiesced } = makeSut();
    try {
      // 취소 신호가 없는 콜백(응답 유실·무한 대기). executor 가 스스로 끊어야 한다.
      const pending = sut.execute({ ...baseInput, execute: () => new Promise<never>(() => {}) });
      await jest.advanceTimersByTimeAsync(REFUND_EXECUTION_TIMEOUT_MS);
      const result = await pending;

      expect(result.status).toBe(RefundAttemptStatus.UNKNOWN);
      // timeout 은 콜백을 취소하지 못한다. 정지 사실(마지막 인자 false)을 남기면 재조정이
      // 아직 살아 있는 콜백을 두고 미실행(FAILED)을 확정해 이중 환불이 열린다.
      expect(settle).toHaveBeenCalledWith(
        expect.anything(),
        { status: RefundAttemptStatus.UNKNOWN, reason: REFUND_EXECUTION_TIMEOUT_REASON },
        expect.any(Date),
        false,
      );
      expect(markExecutionQuiesced).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('timeout 이후 뒤늦게 끝난 콜백의 종료 사실을 기록한다 — 재조정이 쓸 유일한 정지 근거', async () => {
    jest.useFakeTimers();
    const { sut, markExecutionQuiesced } = makeSut();
    let respond: (outcome: unknown) => void = () => undefined;
    try {
      const pending = sut.execute({
        ...baseInput,
        execute: () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      });
      await jest.advanceTimersByTimeAsync(REFUND_EXECUTION_TIMEOUT_MS);
      await pending;
      expect(markExecutionQuiesced).not.toHaveBeenCalled();

      // 워커는 손을 뗐지만 콜백은 살아 있었고, 뒤늦게 응답했다.
      respond({ status: RefundAttemptStatus.SUCCEEDED });
      await jest.advanceTimersByTimeAsync(0);

      expect(markExecutionQuiesced).toHaveBeenCalledWith('91', '3');
    } finally {
      jest.useRealTimers();
    }
  });

  it('claim 은 환불 시작 시점 workflow 상태를 attempt 에 남긴다 — 승격 복원의 기준', async () => {
    const slot = {
      orderDeliveryId: 7,
      op: DeliveryExclusiveOp.REFUND,
      ownerToken: 'owner-1',
      workflowVersion: '12',
    };
    const created: any[] = [];
    const manager = {
      getRepository: jest.fn((entity: any) =>
        entity === DeliveryWorkflowEntity
          ? { findOne: jest.fn().mockResolvedValue({ workflowStatus: DeliveryWorkflowStatus.FAILED_FINAL }) }
          : {
              create: jest.fn((value: any) => {
                created.push(value);
                return value;
              }),
              save: jest.fn(async (value: any) => value),
            },
      ),
    };
    const sut = new RefundAttemptExecutorService(
      {} as any,
      { acquire: jest.fn().mockResolvedValue({ acquired: true, slot }) } as any,
      { transaction: jest.fn(async (run: any) => run(manager)) } as any,
      {} as any,
    );

    const claimed = await (sut as any).claim(baseInput, now);

    expect(created[0]).toEqual(
      expect.objectContaining({
        entryPath: RefundEntryPath.B,
        entryWorkflowStatus: DeliveryWorkflowStatus.FAILED_FINAL,
      }),
    );
    expect(claimed.slot).toBe(slot);
  });

  it('경로 B의 확정 FAILED는 원래 종결 상태를 유지해 무승인 REFUND 재시도를 허용한다', () => {
    const { sut } = makeSut();

    const settlement = (sut as any).workflowSettlement(
      { id: '91', entryPath: RefundEntryPath.B, entryWorkflowStatus: DeliveryWorkflowStatus.CANCELLED },
      { status: RefundAttemptStatus.FAILED, reason: 'provider declined before refund' },
      now,
    );

    expect(settlement.refundStatus).toBe(RefundAttemptStatus.FAILED);
    expect(settlement.workflowStatus).toBeUndefined();
    expect(settlement.activeExclusiveOp).toBeNull();
  });

  it('경로 B의 UNKNOWN만 OPS_REVIEW_REQUIRED로 승격한다', () => {
    const { sut } = makeSut();

    const settlement = (sut as any).workflowSettlement(
      { id: '91', entryPath: RefundEntryPath.B, entryWorkflowStatus: DeliveryWorkflowStatus.CANCELLED },
      { status: RefundAttemptStatus.UNKNOWN, reason: 'response lost' },
      now,
    );

    expect(settlement.workflowStatus).toBe(DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED);
    expect(settlement.opsReviewReason).toBe(OpsReviewReason.REFUND_UNKNOWN);
  });

  it('경로 A의 성공만 RESOLVED_MANUALLY_REFUNDED와 종결 근거 attempt를 함께 기록한다', () => {
    const { sut } = makeSut();

    const settlement = (sut as any).workflowSettlement(
      { id: '91', entryPath: RefundEntryPath.A, entryWorkflowStatus: DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED },
      { status: RefundAttemptStatus.SUCCEEDED },
      now,
    );

    expect(settlement.workflowStatus).toBe(DeliveryWorkflowStatus.RESOLVED_MANUALLY_REFUNDED);
    expect(settlement.settledRefundAttemptId).toBe('91');
    expect(settlement.refundedAt).toBe(now);
  });

  describe('REFUND_UNKNOWN 승격 해제', () => {
    const escalated = {
      workflowStatus: DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
      opsReviewReason: OpsReviewReason.REFUND_UNKNOWN,
    };
    const pathB = {
      id: '91',
      entryPath: RefundEntryPath.B,
      entryWorkflowStatus: DeliveryWorkflowStatus.FAILED_FINAL,
    };

    it('결과가 확정되면 우리가 올린 승격을 내리고 원래 종결 상태로 되돌린다', () => {
      const { sut } = makeSut();

      for (const outcome of [
        { status: RefundAttemptStatus.SUCCEEDED },
        { status: RefundAttemptStatus.FAILED, reason: 'not executed' },
      ]) {
        const settlement = (sut as any).workflowSettlement(pathB, outcome, now, escalated);

        expect(settlement.workflowStatus).toBe(DeliveryWorkflowStatus.FAILED_FINAL);
        expect(settlement.opsReviewReason).toBeNull();
        expect(settlement.opsEscalatedAt).toBeNull();
      }
    });

    it('운영자가 이미 수동 종결했으면 되돌리지 않는다 — 수동 종결은 불변 override', () => {
      const { sut } = makeSut();

      const settlement = (sut as any).workflowSettlement(pathB, { status: RefundAttemptStatus.SUCCEEDED }, now, {
        workflowStatus: DeliveryWorkflowStatus.RESOLVED_MANUALLY_FAILED,
        opsReviewReason: null,
      });

      expect(settlement.workflowStatus).toBeUndefined();
    });

    it('다른 사유의 에스컬레이션은 건드리지 않는다', () => {
      const { sut } = makeSut();

      const settlement = (sut as any).workflowSettlement(pathB, { status: RefundAttemptStatus.SUCCEEDED }, now, {
        workflowStatus: DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
        opsReviewReason: OpsReviewReason.SLA_EXCEEDED,
      });

      expect(settlement.workflowStatus).toBeUndefined();
      expect(settlement.opsReviewReason).toBeUndefined();
    });

    it('시작 상태를 모르는 기존 attempt는 되돌리지 않는다', () => {
      const { sut } = makeSut();

      const settlement = (sut as any).workflowSettlement(
        { ...pathB, entryWorkflowStatus: null },
        { status: RefundAttemptStatus.SUCCEEDED },
        now,
        escalated,
      );

      expect(settlement.workflowStatus).toBeUndefined();
    });
  });

  describe('reconcile', () => {
    const harness = (
      attemptOverrides: Partial<RefundAttemptEntity> = {},
      // 콜백 종료 사실. null = 아직 in-flight 일 수 있음 → 미실행(FAILED) 확정 금지.
      executionQuiescedGeneration: string | null = null,
      currentWorkflow: Record<string, unknown> = { workflowStatus: DeliveryWorkflowStatus.CANCELLED },
    ) => {
      const attempt = Object.assign(new RefundAttemptEntity(), {
        id: '91',
        orderDeliveryId: 7,
        status: RefundAttemptStatus.UNKNOWN,
        entryPath: RefundEntryPath.B,
        amount: 5000,
        scope: RefundScope.FULL,
        ownerToken: 'old-owner',
        generation: '3',
        workflowVersion: '11',
        entryWorkflowStatus: DeliveryWorkflowStatus.CANCELLED,
        ...attemptOverrides,
      });
      const claimSets: any[] = [];
      const settleSets: any[] = [];
      const workflowSets: any[] = [];
      const makeBuilder = (sets: any[]) => {
        const builder: any = {
          update: jest.fn(() => builder),
          set: jest.fn((value) => {
            sets.push(value);
            return builder;
          }),
          where: jest.fn(() => builder),
          andWhere: jest.fn(() => builder),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        return builder;
      };
      const claimBuilder = makeBuilder(claimSets);
      const settleBuilder = makeBuilder(settleSets);
      const workflowBuilder = makeBuilder(workflowSets);
      let refundBuilderCalls = 0;
      const attemptFindOne = jest.fn().mockResolvedValue(attempt);
      const deliveryUpdate = jest.fn().mockResolvedValue({ affected: 1 });
      const manager = {
        getRepository: jest.fn((entity: any) => {
          if (entity === RefundAttemptEntity) {
            return {
              findOne: attemptFindOne,
              createQueryBuilder: jest.fn(() => (refundBuilderCalls++ === 0 ? claimBuilder : settleBuilder)),
            };
          }
          if (entity === DeliveryWorkflowEntity) {
            return {
              findOne: jest.fn().mockResolvedValue(currentWorkflow),
              createQueryBuilder: jest.fn(() => workflowBuilder),
            };
          }
          return { update: deliveryUpdate };
        }),
      };
      const slot = {
        orderDeliveryId: 7,
        op: DeliveryExclusiveOp.RECONCILE,
        ownerToken: 'reconcile-owner',
        workflowVersion: '12',
      };
      const slotService = {
        acquire: jest.fn().mockResolvedValue({ acquired: true, slot }),
        release: jest.fn(),
      };
      const dataSource = {
        transaction: jest.fn(async (callback: (manager: any) => unknown) => callback(manager)),
      };
      const quiescedFindOne = jest.fn().mockResolvedValue({ executionQuiescedGeneration });
      const sut = new RefundAttemptExecutorService(
        { findOne: quiescedFindOne } as any,
        slotService as any,
        dataSource as any,
        {} as any,
      );
      return {
        sut,
        slot,
        slotService,
        manager,
        attemptFindOne,
        claimSets,
        settleSets,
        workflowSets,
        deliveryUpdate,
        quiescedFindOne,
      };
    };

    const reconcileInput = {
      attemptId: '91',
      orderDeliveryId: 7,
      amount: 5000,
      scope: RefundScope.FULL,
    };

    it('RECONCILE 슬롯과 3중 fencing으로 UNKNOWN attempt를 증거 기반 SUCCEEDED로 확정한다', async () => {
      const { sut, manager, attemptFindOne, claimSets, settleSets, workflowSets, deliveryUpdate, slotService } =
        harness();

      const result = await sut.reconcile({
        ...reconcileInput,
        inspect: jest.fn().mockResolvedValue({ status: RefundAttemptStatus.SUCCEEDED }),
      });

      expect(slotService.acquire).toHaveBeenCalledWith(
        expect.objectContaining({ op: DeliveryExclusiveOp.RECONCILE }),
        manager,
      );
      // 직전 실행과 직렬화하지 않으면 정지 판정의 전제(직전 status)가 뒤집힌다.
      expect(attemptFindOne).toHaveBeenCalledWith(expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
      expect(claimSets[0]).toEqual(
        expect.objectContaining({
          status: RefundAttemptStatus.RECONCILING,
          ownerToken: 'reconcile-owner',
          generation: '4',
          workflowVersion: '12',
        }),
      );
      expect(settleSets[0]).toEqual(expect.objectContaining({ status: RefundAttemptStatus.SUCCEEDED }));
      // 경로 B는 기존 종결 상태를 유지한다(RESOLVED_MANUALLY_REFUNDED 재전이 금지).
      expect(workflowSets[0]).toEqual(
        expect.objectContaining({
          refundStatus: RefundAttemptStatus.SUCCEEDED,
          refundedAt: expect.any(Date),
        }),
      );
      expect(workflowSets[0].workflowStatus).toBeUndefined();
      expect(deliveryUpdate).toHaveBeenCalledWith({ id: 7 }, { refundedAt: expect.any(Date) });
      expect(result).toBe(RefundAttemptStatus.SUCCEEDED);
    });

    it('경로 A의 재조정 성공은 RESOLVED_MANUALLY_REFUNDED와 settledRefundAttemptId를 함께 기록한다', async () => {
      const { sut, workflowSets } = harness({ entryPath: RefundEntryPath.A });

      const result = await sut.reconcile({
        ...reconcileInput,
        inspect: jest.fn().mockResolvedValue({ status: RefundAttemptStatus.SUCCEEDED }),
      });

      expect(result).toBe(RefundAttemptStatus.SUCCEEDED);
      expect(workflowSets[0]).toEqual(
        expect.objectContaining({
          workflowStatus: DeliveryWorkflowStatus.RESOLVED_MANUALLY_REFUNDED,
          settledRefundAttemptId: '91',
        }),
      );
    });

    it('직전 SUBMITTING이 아직 정지하지 않았으면 미실행(FAILED)을 확정하지 않는다', async () => {
      const { sut, settleSets, workflowSets, slotService, slot } = harness({
        status: RefundAttemptStatus.SUBMITTING,
      });

      const result = await sut.reconcile({
        ...reconcileInput,
        inspect: jest.fn().mockResolvedValue({
          status: RefundAttemptStatus.FAILED,
          reason: 'REFUND_LEDGER_NOT_CREATED',
        }),
      });

      expect(result).toBe(RefundAttemptStatus.RECONCILING);
      expect(settleSets).toHaveLength(0);
      expect(workflowSets).toHaveLength(0);
      expect(slotService.release).toHaveBeenCalledWith(slot);
    });

    it('콜백 종료 사실이 기록돼 있으면 미실행(FAILED)을 확정한다', async () => {
      const { sut, settleSets, workflowSets, quiescedFindOne } = harness(
        { status: RefundAttemptStatus.SUBMITTING },
        '3',
      );

      const result = await sut.reconcile({
        ...reconcileInput,
        inspect: jest.fn().mockResolvedValue({
          status: RefundAttemptStatus.FAILED,
          reason: 'REFUND_LEDGER_NOT_CREATED',
        }),
      });

      // 스냅샷이 아니라 판정 시점에 다시 읽는다 — 슬롯을 잡은 뒤 끝난 콜백도 이번 sweep 에서 수렴한다.
      expect(quiescedFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: '91' }, select: ['executionQuiescedGeneration'] }),
      );
      expect(result).toBe(RefundAttemptStatus.FAILED);
      expect(settleSets[0]).toEqual(expect.objectContaining({ status: RefundAttemptStatus.FAILED }));
      expect(workflowSets[0].workflowStatus).toBeUndefined();
    });

    it('timeout 이 만든 UNKNOWN 은 정지 근거가 아니다 — 콜백은 아직 살아 있을 수 있다', async () => {
      // hard timeout 은 워커만 대기에서 꺼낸다. 이 상태를 정지로 읽으면 살아남은 콜백이
      // 뒤늦게 실제 환불을 커밋한 뒤에도 attempt 는 FAILED 라 신규 attempt 가 열린다(이중 환불).
      const { sut, settleSets, workflowSets, slotService, slot } = harness({
        status: RefundAttemptStatus.UNKNOWN,
        failureReason: REFUND_EXECUTION_TIMEOUT_REASON,
      });

      const result = await sut.reconcile({
        ...reconcileInput,
        inspect: jest.fn().mockResolvedValue({
          status: RefundAttemptStatus.FAILED,
          reason: 'REFUND_LEDGER_NOT_CREATED',
        }),
      });

      expect(result).toBe(RefundAttemptStatus.RECONCILING);
      expect(settleSets).toHaveLength(0);
      expect(workflowSets).toHaveLength(0);
      expect(slotService.release).toHaveBeenCalledWith(slot);
    });

    it('stale 감사 행이 남은 RECONCILING 도 그것만으로는 정지 근거가 아니다', async () => {
      // heartbeat 상실 + timeout 이 겹치면 콜백이 살아 있는 채로 stale 행 + RECONCILING 이 남는다.
      const { sut, settleSets } = harness({ status: RefundAttemptStatus.RECONCILING });

      const result = await sut.reconcile({
        ...reconcileInput,
        inspect: jest.fn().mockResolvedValue({
          status: RefundAttemptStatus.FAILED,
          reason: 'REFUND_LEDGER_NOT_CREATED',
        }),
      });

      expect(result).toBe(RefundAttemptStatus.RECONCILING);
      expect(settleSets).toHaveLength(0);
    });

    it('CLAIMED 는 외부 호출 전이 확정이므로 종료 기록 없이도 FAILED 로 확정한다', async () => {
      // 재조정이 세대를 올린 순간 markSubmitting 이 영구 실패한다 → 외부 호출은 시작되지 않는다.
      const { sut, settleSets, quiescedFindOne } = harness({ status: RefundAttemptStatus.CLAIMED });

      const result = await sut.reconcile({
        ...reconcileInput,
        inspect: jest.fn().mockResolvedValue({
          status: RefundAttemptStatus.FAILED,
          reason: 'REFUND_LEDGER_NOT_CREATED',
        }),
      });

      expect(result).toBe(RefundAttemptStatus.FAILED);
      expect(settleSets[0]).toEqual(expect.objectContaining({ status: RefundAttemptStatus.FAILED }));
      expect(quiescedFindOne).not.toHaveBeenCalled();
    });

    it('시간이 아무리 지나도 SUBMITTING 자체는 정지 근거가 되지 않는다', async () => {
      // 콜백은 취소되지 않으므로 "오래됐다"는 사실로 미실행을 확정하면 이중 환불이 열린다.
      const { sut, settleSets } = harness({
        status: RefundAttemptStatus.SUBMITTING,
        stateEnteredAt: new Date(Date.now() - REFUND_EXECUTION_TIMEOUT_MS * 100),
      });

      const result = await sut.reconcile({
        ...reconcileInput,
        inspect: jest.fn().mockResolvedValue({
          status: RefundAttemptStatus.FAILED,
          reason: 'REFUND_LEDGER_NOT_CREATED',
        }),
      });

      expect(result).toBe(RefundAttemptStatus.RECONCILING);
      expect(settleSets).toHaveLength(0);
    });

    it('경로 B: UNKNOWN 승격 → 재조정 성공 → 원래 종결 상태 복원 + OPS 사유 정리', async () => {
      // execute 단계에서 경로 B UNKNOWN 이 만든 상태를 그대로 재현한다.
      const escalation = (makeSut().sut as any).workflowSettlement(
        { id: '91', entryPath: RefundEntryPath.B, entryWorkflowStatus: DeliveryWorkflowStatus.CANCELLED },
        { status: RefundAttemptStatus.UNKNOWN, reason: 'response lost' },
        now,
      );
      expect(escalation.workflowStatus).toBe(DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED);

      const { sut, workflowSets } = harness({ status: RefundAttemptStatus.UNKNOWN }, null, {
        workflowStatus: escalation.workflowStatus,
        opsReviewReason: escalation.opsReviewReason,
      });

      const result = await sut.reconcile({
        ...reconcileInput,
        inspect: jest.fn().mockResolvedValue({ status: RefundAttemptStatus.SUCCEEDED }),
      });

      expect(result).toBe(RefundAttemptStatus.SUCCEEDED);
      expect(workflowSets[0]).toEqual(
        expect.objectContaining({
          workflowStatus: DeliveryWorkflowStatus.CANCELLED,
          refundStatus: RefundAttemptStatus.SUCCEEDED,
          opsReviewReason: null,
          opsEscalatedAt: null,
        }),
      );
    });
  });

  it('stale 감사와 RECONCILING 전이를 같은 트랜잭션에서 수행하고 전이에 3중 fencing을 건다', async () => {
    const conditions: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const builder: any = {
      update: jest.fn(() => builder),
      set: jest.fn(() => builder),
      where: jest.fn((sql: string, params?: Record<string, unknown>) => {
        conditions.push({ sql, params });
        return builder;
      }),
      andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
        conditions.push({ sql, params });
        return builder;
      }),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const staleSave = jest.fn().mockResolvedValue(undefined);
    const staleCreate = jest.fn((value) => value);
    const manager = {
      getRepository: jest.fn((entity: any) => {
        if (entity === RefundAttemptEntity) {
          return {
            findOne: jest.fn().mockResolvedValue({
              ownerToken: 'owner-2',
              generation: '4',
              workflowVersion: '13',
            }),
            createQueryBuilder: jest.fn(() => builder),
          };
        }
        if (entity === DeliveryWorkflowEntity) {
          return {
            findOne: jest.fn().mockResolvedValue({
              exclusiveOwnerToken: 'owner-2',
              workflowVersion: '13',
            }),
            createQueryBuilder: jest.fn(() => builder),
          };
        }
        if (entity === StaleExternalResponseEntity) {
          return { create: staleCreate, save: staleSave };
        }
        throw new Error(`unexpected repository: ${entity?.name}`);
      }),
    };
    const cryptoCipher = { encryptJson: jest.fn().mockReturnValue('v2:encrypted') };
    const dataSource = {
      transaction: jest.fn(async (run) => run(manager)),
    };
    const sut = new RefundAttemptExecutorService({} as any, {} as any, dataSource as any, cryptoCipher as any);
    const outcome = { status: RefundAttemptStatus.SUCCEEDED } as const;

    await (sut as any).recordStaleAndReconcile(claimedRefund(), outcome, now, true);

    expect(staleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKey: '91',
        mismatchReason: StaleMismatchReason.MULTIPLE,
        responseBodyEnc: 'v2:encrypted',
      }),
    );
    expect(staleSave).toHaveBeenCalled();
    expect(cryptoCipher.encryptJson).toHaveBeenCalledWith(outcome);
    expect(conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sql: 'owner_token = :ownerToken', params: { ownerToken: 'owner-1' } }),
        expect.objectContaining({ sql: 'generation = :generation', params: { generation: '3' } }),
        expect.objectContaining({ sql: 'workflow_version = :workflowVersion', params: { workflowVersion: '12' } }),
      ]),
    );
    expect(builder.set).toHaveBeenCalledWith(
      expect.objectContaining({
        activeExclusiveOp: null,
        exclusiveOwnerToken: null,
        exclusiveLeaseExpiresAt: null,
      }),
    );
    // 콜백 종료는 상태 전이가 아니라 사실이다. fencing 을 잃은 워커의 관측도 유효하므로
    // 소유권·세대 조건 없이 단조 증가 조건만 걸고 같은 트랜잭션에서 남긴다.
    expect(builder.set).toHaveBeenCalledWith({ executionQuiescedGeneration: '3' });
    expect(conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sql: expect.stringContaining('execution_quiesced_generation IS NULL') }),
      ]),
    );
  });

  it('fencing 불일치가 없는 heartbeat 장애는 HEARTBEAT_ERROR로 분류한다', () => {
    const sut = new RefundAttemptExecutorService({} as any, {} as any, {} as any, {} as any);
    const claimed = claimedRefund();

    expect(
      (sut as any).mismatchReason(
        claimed,
        {
          ownerToken: claimed.slot.ownerToken,
          generation: claimed.attempt.generation,
          workflowVersion: claimed.slot.workflowVersion,
        },
        {
          exclusiveOwnerToken: claimed.slot.ownerToken,
          workflowVersion: claimed.slot.workflowVersion,
        },
        true,
      ),
    ).toBe(StaleMismatchReason.HEARTBEAT_ERROR);
  });
});
