// 실제 DB 연결 없는 단위 테스트이므로 typeorm-transactional 데코레이터를 no-op 으로 mock 한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  IsolationLevel: {
    READ_UNCOMMITTED: 'READ UNCOMMITTED',
    READ_COMMITTED: 'READ COMMITTED',
    REPEATABLE_READ: 'REPEATABLE READ',
    SERIALIZABLE: 'SERIALIZABLE',
  },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
  runOnTransactionCommit: jest.fn(),
  runOnTransactionRollback: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { ConflictException } from '@nestjs/common';
import { DELIVERY_CUTOVER_LEGACY_BLOCKED, LegacyDeliveryEntryPoint } from '../interface/legacy.delivery.entry.point';
import { SsgRecoveryService } from './ssg-recovery.service';
import { SsgRecoveryResult } from '../interface/ssg.recovery.result';
import { RefundLedgerService, ClaimRefundInput } from './refund-ledger.service';
import { MessageAttemptService } from './message-attempt.service';
import { MessageResendExecutorService } from './message-resend-executor.service';
import { DeliveryExclusiveOp } from '../interface/delivery.workflow.status';
import { RefundAttemptEntity } from '../../entity/refund.attempt.entity';
import { RefundAttemptStatus } from '../interface/refund.attempt.status';
import { DeliveryBatchService } from './delivery.batch.service';
import { CustomerServiceService } from '../../customer_service/application/customer.service.service';
import { ExternalApiService } from '../../external_api/application/external.api.service';
import { PartnerCompanyExternHistoryService } from '../../partner_company_extern_history/application/partner.company.extern.history.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';

/**
 * §9 컷오버 acceptance — "전환 건 legacy 진입 시도 = 거부" 회귀 테스트.
 *
 * 계약: 「위 12개 진입점 각각에 대해 회귀 테스트를 둔다. 테스트가 없는 진입점은 컷오버 대상에서
 * 제외하지 않고 **컷오버를 미룬다**.」
 *
 * **동작 테스트로 검증한다.** 소스에 가드 호출 문자열이 있는지만 보면, 가드가 외부 호출·상태 변경
 * **뒤로** 밀려도 통과해 "최상단 거부" 계약을 보장하지 못한다. 그래서 각 진입점을 실제로 호출하고
 * 다음 두 가지를 함께 확인한다.
 *   ① 거부가 `ConflictException(DELIVERY_CUTOVER_LEGACY_BLOCKED)` 로 일어날 것
 *   ② 거부 시점까지 **협력자를 하나도 건드리지 않았을 것**
 *      — 대상 서비스는 `Object.create` 로 만들고 `cutoverGuard` 외에는 아무 의존도 주입하지 않는다.
 *        가드가 뒤로 밀리면 그 사이 코드가 `undefined` 협력자를 만져 `TypeError` 가 나므로,
 *        "ConflictException 이어야 한다"는 단언이 그대로 깨진다.
 */
describe('§9 컷오버 — legacy 진입점 12곳 거부', () => {
  const orderDeliveryId = 1234;

  /** 전환 건에서 항상 거부하는 가드. 실제 가드의 거부 형태를 그대로 흉내낸다. */
  const blockingGuard = (entryPoint: LegacyDeliveryEntryPoint) => ({
    assertLegacyAllowed: jest.fn().mockRejectedValue(
      new ConflictException({
        code: DELIVERY_CUTOVER_LEGACY_BLOCKED,
        entryPoint,
        orderDeliveryIds: [orderDeliveryId],
      }),
    ),
    assertRefundExecutionAllowed: jest
      .fn()
      .mockRejectedValue(new ConflictException({ code: DELIVERY_CUTOVER_LEGACY_BLOCKED, entryPoint })),
    isCutover: jest.fn().mockResolvedValue(true),
  });

  const expectBlocked = async (run: () => Promise<unknown>, entryPoint: LegacyDeliveryEntryPoint) => {
    const error = await run()
      .then(() => null)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as Record<string, unknown>;
    expect(body.code).toBe(DELIVERY_CUTOVER_LEGACY_BLOCKED);
    if (body.entryPoint !== undefined) {
      expect(body.entryPoint).toBe(entryPoint);
    }
  };

  describe('#1·#4 발송 — 전환 건은 배타 슬롯 없이 발송하지 않는다', () => {
    // 두 경로(배치·외부 API)의 실제 발송은 모두 MessageAttemptService.trackSend 를 거친다.
    // 여기서는 그 게이트의 동작을 직접 호출해 검증한다.
    const createAttemptService = (opts: { isCutover?: jest.Mock; acquire?: jest.Mock }) => {
      const slotService = {
        ensureWorkflow: jest.fn().mockResolvedValue({ workflowVersion: '3', cutoverMigratedAt: null }),
        acquire: opts.acquire ?? jest.fn().mockResolvedValue({ acquired: false, code: 'DELIVERY_OPERATION_LOCKED' }),
        release: jest.fn(),
      };
      const cutoverGuard = { isCutover: opts.isCutover ?? jest.fn().mockResolvedValue(true) };
      const service = new MessageAttemptService(
        { save: jest.fn(), update: jest.fn() } as never,
        slotService as never,
        {} as never,
        cutoverGuard as never,
      );
      return { service, slotService, cutoverGuard };
    };

    const ctx = {
      orderDeliveryId,
      channel: 'SMS',
      slotOp: DeliveryExclusiveOp.MESSAGE_SEND,
    };

    it('전환 건은 슬롯 점유 실패 시 발송 함수를 호출하지 않는다(fail-closed)', async () => {
      const { service } = createAttemptService({});
      const send = jest.fn();

      await expect(service.trackSend(ctx as never, send)).rejects.toBeInstanceOf(ConflictException);
      expect(send).not.toHaveBeenCalled();
    });

    it('전환 여부 조회가 실패하면 발송하지 않는다 — 모르는 채 legacy 로 내보내지 않는다', async () => {
      // 과거 구현은 조회 실패를 삼켜 cutover=false 로 발송했다(fail-open). 전환 건이 슬롯 없이
      // 나가 두 동시성 모델이 동시에 열리는 경로였다. 이 테스트가 그 회귀를 막는다.
      const { service } = createAttemptService({
        isCutover: jest.fn().mockRejectedValue(new Error('db unavailable')),
      });
      const send = jest.fn();

      await expect(service.trackSend(ctx as never, send)).rejects.toThrow('db unavailable');
      expect(send).not.toHaveBeenCalled();
    });

    it('드레이닝 중에는 legacy·신규 어느 모델로도 발송하지 않는다(quiesce)', async () => {
      // 드레이닝 확인과 전환 마크 설정 사이의 admission race 를 닫는 구간. 여기서 신규 모델을 먼저
      // 시작하면 아직 빠져나가지 못한 legacy 워커와 겹친다.
      const { service, slotService } = createAttemptService({
        isCutover: jest
          .fn()
          .mockRejectedValue(new ConflictException({ code: 'DELIVERY_CUTOVER_DRAINING', phase: 'DRAINING' })),
      });
      const send = jest.fn();

      await expect(service.trackSend(ctx as never, send)).rejects.toBeInstanceOf(ConflictException);
      expect(send).not.toHaveBeenCalled();
      expect(slotService.acquire).not.toHaveBeenCalled();
    });

    it('미전환 건은 앵커 생성이 실패해도 기존 경로로 발송한다(shadow 무해성)', async () => {
      const { service, slotService } = createAttemptService({
        isCutover: jest.fn().mockResolvedValue(false),
      });
      slotService.ensureWorkflow.mockRejectedValue(new Error('anchor insert failed'));
      const send = jest.fn().mockResolvedValue({ success: true });

      await expect(service.trackSend(ctx as never, send)).resolves.toEqual({ success: true });
      expect(send).toHaveBeenCalled();
      expect(slotService.acquire).not.toHaveBeenCalled();
    });
  });

  describe('#2 발송실패내역 수동 재발송', () => {
    it('전환 건은 대상 조회 전에 거부된다', async () => {
      const sut: any = Object.create(PartnerCompanyExternHistoryService.prototype);
      sut.cutoverGuard = blockingGuard(LegacyDeliveryEntryPoint.FAILURE_LIST_RESEND);

      await expectBlocked(
        () => sut.resendFailedDelivery(orderDeliveryId),
        LegacyDeliveryEntryPoint.FAILURE_LIST_RESEND,
      );
    });
  });

  describe('#3 CS 재발송', () => {
    it('전환 건은 claim 전에 거부된다', async () => {
      const sut: any = Object.create(CustomerServiceService.prototype);
      sut.cutoverGuard = blockingGuard(LegacyDeliveryEntryPoint.CS_RESEND);

      await expectBlocked(() => sut.reSend({ id: 1 }, { orderDeliveryId }), LegacyDeliveryEntryPoint.CS_RESEND);
    });
  });

  describe('#5 배치 발송 실패 환불', () => {
    it('전환 건은 refund_attempt 실행기에 위임된다', async () => {
      const sut: any = Object.create(DeliveryBatchService.prototype);
      sut.cutoverGuard = { isCutover: jest.fn().mockResolvedValue(true) };
      sut.refundAttemptExecutor = { execute: jest.fn().mockResolvedValue({ status: 'SUCCEEDED' }) };
      sut.messageResultReconcileService = {
        markWorkflowFailedIfSettled: jest.fn().mockResolvedValue(undefined),
      };

      await sut.refundForFail({
        id: orderDeliveryId,
        settleFee: null,
        settlePriceAdjustment: null,
        orderProductMapping: {
          order: { cardSurchargeApplied: false },
          product: { price: 1000 },
          productPriceSnapshot: 1000,
          fee: null,
          priceAdjustment: null,
        },
      });

      expect(sut.messageResultReconcileService.markWorkflowFailedIfSettled.mock.invocationCallOrder[0]).toBeLessThan(
        sut.refundAttemptExecutor.execute.mock.invocationCallOrder[0],
      );

      expect(sut.refundAttemptExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          orderDeliveryId,
          amount: 1000,
          scope: 'FULL',
          execute: expect.any(Function),
        }),
      );
    });
  });

  describe('#6·#7 외부 API 환불·취소', () => {
    it('발송 실패 환불은 상태 저장 후 refund_attempt 실행기에 위임된다', async () => {
      const sut: any = Object.create(ExternalApiService.prototype);
      sut.cutoverGuard = { isCutover: jest.fn().mockResolvedValue(true) };
      sut.phaseC_persistFailure = jest.fn().mockResolvedValue(undefined);
      sut.refundAttemptExecutor = { execute: jest.fn().mockResolvedValue({ status: 'SUCCEEDED' }) };
      sut.messageResultReconcileService = {
        markWorkflowFailedIfSettled: jest.fn().mockResolvedValue(undefined),
      };
      const order = { settleAmount: 1000 };
      const orderDelivery = { id: orderDeliveryId, status: 'WAIT' };

      await sut.phaseC_handleFailure(order, orderDelivery, {}, new Error('boom'));

      expect(sut.phaseC_persistFailure).toHaveBeenCalledWith(order, orderDelivery, expect.any(Error));
      expect(sut.refundAttemptExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          orderDeliveryId,
          amount: 1000,
          scope: 'FULL',
          execute: expect.any(Function),
        }),
      );
    });

    it('취소 환불은 상태 targeted update 전에 거부된다', async () => {
      const sut: any = Object.create(ExternalApiService.prototype);
      sut.cutoverGuard = blockingGuard(LegacyDeliveryEntryPoint.EXTERNAL_API_CANCEL_REFUND);
      const orderDelivery = { id: orderDeliveryId, status: 'COMPLETE' };

      await expectBlocked(
        () => sut.processCancelRefund({}, orderDelivery, {}, new Date()),
        LegacyDeliveryEntryPoint.EXTERNAL_API_CANCEL_REFUND,
      );
      expect(orderDelivery.status).toBe('COMPLETE');
    });

    it('cancelOrder 는 DISCARD 슬롯 획득 실패 시 협력사 취소 전에 중단된다', async () => {
      const sut: any = Object.create(ExternalApiService.prototype);
      sut.cutoverGuard = { isCutover: jest.fn().mockResolvedValue(true) };
      sut.findOrderDeliveryByTrId = jest.fn().mockResolvedValue({
        id: orderDeliveryId,
        orderProductMapping: { order: { type: 'GENERAL' }, product: {} },
      });
      sut.deliveryWorkflowSlotService = {
        acquire: jest.fn().mockResolvedValue({ acquired: false, code: 'DELIVERY_OPERATION_LOCKED' }),
      };
      sut.partnerCompanyExternService = { cancelByExternalApi: jest.fn() };

      await expect(sut.cancelOrder({}, 'TR-1', {})).rejects.toBeDefined();

      expect(sut.deliveryWorkflowSlotService.acquire).toHaveBeenCalledWith({
        orderDeliveryId,
        op: DeliveryExclusiveOp.DISCARD,
      });
      expect(sut.partnerCompanyExternService.cancelByExternalApi).not.toHaveBeenCalled();
    });

    it('협력사 취소 후 workflow fencing 실패는 durable intent를 재조정 대상으로 남긴다', async () => {
      const sut: any = Object.create(ExternalApiService.prototype);
      const slot = {
        orderDeliveryId,
        ownerToken: 'discard-owner',
        workflowVersion: '4',
      };
      const orderDelivery = {
        id: orderDeliveryId,
        status: 'COMPLETE',
        couponStatus: 'NOT_USED',
        expireAt: null,
        barCode: 'PIN-1',
        discardedAt: null,
        orderProductMapping: {
          order: { type: 'GENERAL' },
          product: { isCancelable: true, partnerCompany: { id: 1 } },
        },
      };

      sut.cutoverGuard = { isCutover: jest.fn().mockResolvedValue(true) };
      sut.findOrderDeliveryByTrId = jest.fn().mockResolvedValue(orderDelivery);
      sut.orderDeliveryRepository = {
        findOne: jest.fn().mockResolvedValue({
          status: 'COMPLETE',
          couponStatus: 'NOT_USED',
          expireAt: null,
          barCode: 'PIN-1',
          discardedAt: null,
        }),
      };
      sut.deliveryWorkflowSlotService = {
        acquire: jest.fn().mockResolvedValue({ acquired: true, slot }),
        release: jest.fn().mockResolvedValue(false),
      };
      sut.deliveryCancelIntentService = {
        create: jest.fn().mockResolvedValue({ id: 'intent-1' }),
        markExternalCancelled: jest.fn().mockResolvedValue(undefined),
        markReconciling: jest.fn().mockResolvedValue(undefined),
      };
      sut.partnerCompanyExternService = {
        cancelByExternalApi: jest.fn().mockResolvedValue(undefined),
      };
      sut.processCutoverCancelRefund = jest.fn().mockRejectedValue(new Error('workflow fencing lost'));

      await expect(sut.cancelOrder({}, 'TR-1', {})).rejects.toThrow('workflow fencing lost');

      expect(sut.deliveryCancelIntentService.create.mock.invocationCallOrder[0]).toBeLessThan(
        sut.partnerCompanyExternService.cancelByExternalApi.mock.invocationCallOrder[0],
      );
      expect(sut.deliveryCancelIntentService.markExternalCancelled).toHaveBeenCalledWith('intent-1', slot);
      expect(sut.deliveryCancelIntentService.markReconciling).toHaveBeenCalledWith(
        'intent-1',
        'EXTERNAL_CANCEL_FLOW_FAILED:workflow fencing lost',
      );
    });
  });

  describe('#8 CS 폐기 시 예치금·여신 복구(Tx2)', () => {
    it('전환 건은 ledger 조회 전에 거부된다', async () => {
      const sut: any = Object.create(CustomerServiceService.prototype);
      sut.cutoverGuard = blockingGuard(LegacyDeliveryEntryPoint.CS_DISCARD_RESTORE);

      await expectBlocked(
        () =>
          sut.restoreBalanceOnDiscard(
            { id: orderDeliveryId, orderProductMapping: { order: {} } },
            { id: 1 },
            { manager: {} },
          ),
        LegacyDeliveryEntryPoint.CS_DISCARD_RESTORE,
      );
    });
  });

  describe('#9 SSG 행사 잔액 복구', () => {
    it('발송 실패 복구는 행사 조회 전에 거부된다', async () => {
      const sut: any = Object.create(SsgEventService.prototype);
      sut.cutoverGuard = blockingGuard(LegacyDeliveryEntryPoint.SSG_EVENT_REFUND);

      await expectBlocked(
        () => sut.refundForDeliveryFail(1, 2, 5000, orderDeliveryId),
        LegacyDeliveryEntryPoint.SSG_EVENT_REFUND,
      );
    });

    it('재발송 선차감 역복원도 발송건이 특정되면 거부된다', async () => {
      const sut: any = Object.create(SsgEventService.prototype);
      sut.cutoverGuard = blockingGuard(LegacyDeliveryEntryPoint.SSG_EVENT_REFUND);

      await expectBlocked(
        () =>
          sut.refundResendEventDeduction({
            resendDeductionId: 'RD-1',
            ssgEventId: 1,
            orderId: 2,
            amount: 5000,
            orderDeliveryId,
          }),
        LegacyDeliveryEntryPoint.SSG_EVENT_REFUND,
      );
    });
  });

  describe('#10 SSG 복구 sweep(cron)', () => {
    it('전환 건은 lease claim 조차 시도하지 않는다', async () => {
      const refundRepository = { createQueryBuilder: jest.fn() };
      const guard = { isCutover: jest.fn().mockResolvedValue(true) };
      const service = new SsgRecoveryService(refundRepository as never, {} as never, guard as never);

      const result = await service.recoverWithLease(orderDeliveryId, 1, 2, 5000);

      // cron 이므로 예외로 배치를 멈추지 않는다. 대신 legacy claim 이 일어나지 않아야 한다.
      expect(result).toBe(SsgRecoveryResult.SKIPPED_NO_CLAIM);
      expect(refundRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('#12 ledger claim — refund_attempt 하위로만 허용', () => {
    // BIGINT 컬럼과 대조되므로 전부 string 이다(§6.1 3중 fencing).
    const fencing = {
      refundAttemptId: '9007199254740993',
      ownerToken: 'owner-token-1',
      generation: '3',
      workflowVersion: '9',
      externalIdempotencyKey: 'refund-attempt:9007199254740993',
    };

    const baseInput: ClaimRefundInput = {
      orderDeliveryId,
      userId: 1,
      refundAmount: 5000,
      restoreType: 'BALANCE',
      isSettleComplete: false,
      isSettleBalance: false,
      sourcePath: 'BATCH_FAIL',
    };

    const createLedger = (allow: boolean, attemptOverrides: Record<string, unknown> = {}) => {
      const chain: any = {
        insert: jest.fn(() => chain),
        into: jest.fn(() => chain),
        values: jest.fn(() => chain),
        update: jest.fn(() => chain),
        set: jest.fn(() => chain),
        where: jest.fn(() => chain),
        execute: jest.fn().mockResolvedValue({ affected: 1, identifiers: [{ id: 1 }] }),
      };
      // 전환 건 claim 은 attempt 행을 잠금 읽기로 확정한 뒤에만 원장을 쓴다.
      const attemptFindOne = jest.fn().mockResolvedValue({
        id: fencing.refundAttemptId,
        orderDeliveryId,
        status: RefundAttemptStatus.SUBMITTING,
        ownerToken: fencing.ownerToken,
        generation: fencing.generation,
        workflowVersion: fencing.workflowVersion,
        ...attemptOverrides,
      });
      const repository = { createQueryBuilder: jest.fn(() => chain) } as never;
      const manager = {
        getRepository: jest.fn((entity: any) =>
          entity === RefundAttemptEntity ? { findOne: attemptFindOne } : repository,
        ),
      };
      const dataSource = { transaction: jest.fn(async (run: any) => run(manager)) } as never;
      const guard = {
        assertRefundExecutionAllowed: allow
          ? jest.fn().mockResolvedValue(undefined)
          : jest.fn().mockRejectedValue(
              new ConflictException({
                code: DELIVERY_CUTOVER_LEGACY_BLOCKED,
                entryPoint: LegacyDeliveryEntryPoint.REFUND_LEDGER_CLAIM,
              }),
            ),
      };
      return {
        service: new RefundLedgerService(repository, repository, guard as never, dataSource),
        chain,
        guard,
        manager,
        attemptFindOne,
      };
    };

    it('게이트를 통과하지 못하면 ledger 를 쓰지 않는다', async () => {
      const { service, chain } = createLedger(false);

      await expectBlocked(() => service.claim(baseInput), LegacyDeliveryEntryPoint.REFUND_LEDGER_CLAIM);
      expect(chain.execute).not.toHaveBeenCalled();
    });

    it('게이트 검증 자체를 fencing 제시 여부로 건너뛰지 않는다', async () => {
      const { service, guard, manager } = createLedger(false);

      await expectBlocked(
        () => service.claim({ ...baseInput, refundExecution: fencing }),
        LegacyDeliveryEntryPoint.REFUND_LEDGER_CLAIM,
      );
      // 값을 넘겨도 가드는 호출된다(= 제시만으로 우회 불가). 소유·상태·슬롯·fencing 대조는 가드 spec 담당.
      // 전환 건은 attempt 잠금과 같은 트랜잭션이어야 하므로 manager 를 넘긴다.
      expect(guard.assertRefundExecutionAllowed).toHaveBeenCalledWith(
        expect.objectContaining({ orderDeliveryId, fencing }),
        manager,
      );
    });

    it('세대가 회수된 실행은 게이트 이전에 원장을 쓰지 못한다', async () => {
      // 재조정이 세대를 올린 뒤라면 살아남은 콜백도 환불을 커밋하지 못해야 한다.
      const { service, chain, guard } = createLedger(true, { generation: '99' });

      await expect(service.claim({ ...baseInput, refundExecution: fencing })).rejects.toMatchObject({
        response: { code: 'REFUND_EXECUTION_STALE' },
      });
      expect(chain.execute).not.toHaveBeenCalled();
      expect(guard.assertRefundExecutionAllowed).not.toHaveBeenCalled();
    });

    it('실행 중이 아닌 attempt 의 claim 도 거부한다', async () => {
      const { service, chain } = createLedger(true, { status: RefundAttemptStatus.RECONCILING });

      await expect(service.claim({ ...baseInput, refundExecution: fencing })).rejects.toMatchObject({
        response: { code: 'REFUND_EXECUTION_STALE' },
      });
      expect(chain.execute).not.toHaveBeenCalled();
    });

    it('attempt 행을 잠금 읽기로 확정한다 — 재조정과 직렬화되지 않으면 이중 환불이 열린다', async () => {
      const { service, attemptFindOne } = createLedger(true);

      await service.claim({ ...baseInput, refundExecution: fencing });

      expect(attemptFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('게이트를 통과하면 attempt id와 외부 멱등키를 ledger에 기록한다', async () => {
      const { service, chain } = createLedger(true);

      await service.claim({ ...baseInput, refundExecution: fencing });

      expect(chain.execute).toHaveBeenCalled();
      expect(chain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          refundAttemptId: fencing.refundAttemptId,
          externalIdempotencyKey: fencing.externalIdempotencyKey,
        }),
      );
    });

    it('claimWithManager 도 같은 게이트를 거친다', async () => {
      const { service, guard } = createLedger(false);
      const manager = { getRepository: jest.fn() } as never;

      await expectBlocked(
        () => service.claimWithManager(manager, baseInput),
        LegacyDeliveryEntryPoint.REFUND_LEDGER_CLAIM,
      );
      expect(guard.assertRefundExecutionAllowed).toHaveBeenCalledWith(expect.anything(), manager);
    });
  });

  describe('quiesce — legacy claim CAS 에 컷오버 술어가 원자적으로 실린다', () => {
    /**
     * 가드(`assertLegacyAllowed`)만으로는 admission race 가 남는다.
     *   legacy worker: NONE 확인 → 스케줄러/DB 대기
     *   operator     : DRAINING → 대기 → 잔여 0 확인 → MIGRATED
     *   legacy worker: 재개 → claim
     * 이 워커의 claim 은 잔여 확인 시점에 존재하지 않아 대기 시간으로는 잡히지 않는다.
     * 그래서 **점유와 같은 문장**에 술어를 넣어 마크 이후의 claim 이 affected=0 이 되게 한다.
     *
     * 여기서 검증하는 대상은 "가드 호출 여부"가 아니라 **CAS 에 실제로 실리는 SQL 술어**다.
     * 술어가 빠지면 그 진입점의 원자성이 사라지므로, 술어 존재 자체가 계약이다.
     */
    const captureConditions = () => {
      const conditions: string[] = [];
      const qb: any = {
        update: jest.fn(() => qb),
        set: jest.fn(() => qb),
        where: jest.fn((sql: string) => {
          conditions.push(sql);
          return qb;
        }),
        andWhere: jest.fn((sql: string) => {
          conditions.push(sql);
          return qb;
        }),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      const repository: { createQueryBuilder: jest.Mock; findOne: jest.Mock } = {
        createQueryBuilder: jest.fn(() => qb),
        findOne: jest.fn().mockResolvedValue(null),
      };
      return { qb, conditions, repository };
    };

    const expectPredicate = (conditions: string[], deliveryIdExpr: string) => {
      const sql = conditions.join(' | ');
      expect(sql).toContain('NOT EXISTS (SELECT 1 FROM delivery_workflow dw');
      expect(sql).toContain(`dw.order_delivery_id = ${deliveryIdExpr}`);
      expect(sql).toContain('dw.cutover_draining_at IS NOT NULL OR dw.cutover_migrated_at IS NOT NULL');
    };

    it('배치 발송 claim(claimWaitDeliveries)', async () => {
      const { conditions, repository } = captureConditions();
      const sut: any = Object.create(DeliveryBatchService.prototype);
      sut.orderDeliveryRepository = repository;

      await sut.claimWaitDeliveries(new Date());

      expectPredicate(conditions, 'order_delivery.id');
    });

    it('CS 재발송 claim', async () => {
      const { conditions, repository } = captureConditions();
      const sut: any = Object.create(CustomerServiceService.prototype);
      sut.cutoverGuard = { assertLegacyAllowed: jest.fn().mockResolvedValue(undefined) };
      sut.orderDeliveryRepository = repository;
      sut.buildReSendQuery = jest.fn(() => ({
        getOne: async () => ({
          id: orderDeliveryId,
          deliveryTarget: '01000000000',
          couponStatus: null,
          orderProductMapping: { product: { type: 'GENERAL' } },
        }),
      }));
      sut.resolveCsCouponAuthority = jest.fn(() => 'CS_GENERAL');
      sut.authService = { authorityValidator: jest.fn().mockResolvedValue(undefined) };

      // claim 이 affected=0 이라 ConflictException 으로 끝난다 — 술어 캡처가 목적이다.
      await sut.reSend({ id: 1 }, { orderDeliveryId }).catch(() => undefined);

      expectPredicate(conditions, 'order_delivery.id');
    });

    it('CS 변형 lease(acquireMutationLease)', async () => {
      const { conditions, repository } = captureConditions();
      const sut: any = Object.create(CustomerServiceService.prototype);
      sut.orderDeliveryRepository = repository;

      await sut.acquireMutationLease(orderDeliveryId, new Date());

      expectPredicate(conditions, 'order_delivery.id');
    });

    it('발송실패내역 수동 재발송 claim', async () => {
      const { conditions, repository } = captureConditions();
      const sut: any = Object.create(PartnerCompanyExternHistoryService.prototype);
      sut.cutoverGuard = { assertLegacyAllowed: jest.fn().mockResolvedValue(undefined) };
      sut.orderDeliveryRepository = repository;
      sut.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      sut.buildResendQuery = jest.fn(() => ({
        getOne: async () => ({
          id: orderDeliveryId,
          barCode: 'PIN-1',
          orderProductMapping: { product: { type: 'GENERAL', partnerCompany: { type: 'GIFT_SHOW' } } },
        }),
      }));
      sut.classifyResendRejection = jest.fn();

      await sut.resendFailedDelivery(orderDeliveryId).catch(() => undefined);

      expectPredicate(conditions, 'order_delivery.id');
    });

    it('외부 API 변형 lease(acquireMutationLease)', async () => {
      const { conditions, repository } = captureConditions();
      const sut: any = Object.create(ExternalApiService.prototype);
      sut.orderDeliveryRepository = repository;

      await sut.acquireMutationLease(orderDeliveryId, new Date());

      expectPredicate(conditions, 'order_delivery.id');
    });

    it('배치 report fallback 변형 lease', async () => {
      const { conditions, repository } = captureConditions();
      const sut: any = Object.create(DeliveryBatchService.prototype);
      sut.orderDeliveryRepository = repository;
      sut.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      // lease 획득 실패(affected=0) 후 원인 분기용 재조회. 술어 캡처가 목적이라 대상 없음으로 끝낸다.
      repository.findOne = jest.fn().mockResolvedValue(null);

      await sut
        .runReportFallback({ id: orderDeliveryId, orderProductMapping: { order: {}, product: {} } }, 'token-1')
        .catch(() => undefined);

      expectPredicate(conditions, 'order_delivery.id');
    });

    it('외부 API 재발송 슬롯 claim(resendOrder)', async () => {
      const { conditions, repository } = captureConditions();
      const sut: any = Object.create(ExternalApiService.prototype);
      sut.orderDeliveryRepository = Object.assign(repository, {
        findOne: jest.fn().mockResolvedValue({ resendCount: 9, couponStatus: null, mutationClaimedAt: null }),
      });
      sut.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      sut.findOrderDeliveryByTrId = jest.fn().mockResolvedValue({
        id: orderDeliveryId,
        barCode: 'PIN-1',
        couponStatus: null,
        orderProductMapping: { order: { status: 'DELIVERY_COMPLETE' } },
      });
      sut.resolveResendMax = jest.fn(() => 3);

      // claim affected=0 → 한도/경합 분기로 예외. 술어 캡처가 목적이다.
      await sut.resendOrder({}, 'TR-1', {}).catch(() => undefined);

      expectPredicate(conditions, 'order_delivery.id');
    });

    it('dueResend legacy 게이트', async () => {
      const { conditions, repository } = captureConditions();
      const sut: any = Object.create(MessageResendExecutorService.prototype);
      sut.orderDeliveryRepository = repository;
      sut.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

      // 미전환 건(cutoverMigratedAt=null) 경로여야 legacy CAS 를 탄다.
      await sut.acquireGate({ cutoverMigratedAt: null }, orderDeliveryId, new Date(), false);

      expectPredicate(conditions, 'order_delivery.id');
    });

    it('SSG 복구 sweep lease(다른 테이블 기준 컬럼)', async () => {
      const { conditions, repository } = captureConditions();
      const guard = { isCutover: jest.fn().mockResolvedValue(false) };
      const service = new SsgRecoveryService(repository as never, {} as never, guard as never);

      await service.recoverWithLease(orderDeliveryId, 1, 2, 5000);

      expectPredicate(conditions, 'order_delivery_refund.order_delivery_id');
    });
  });

  describe('#11 RefundPoolService — 진입점이 아니라 하위 실행기다', () => {
    // 계약: 「5~8 외 신규 호출자 추가 금지를 리뷰 게이트로 강제」.
    // 호출자가 늘면 그 경로는 refund_attempt 종속을 거치지 않은 새 환불 진입점이 된다.
    const ALLOWED_CALLERS = [
      'src/customer_service/application/customer.service.service.ts', // #8 CS 폐기 복구
      'src/delivery/application/delivery.batch.service.ts', // #5 배치 실패 환불
      'src/external_api/application/external.api.service.ts', // #6·#7 외부 API 환불
      // #13 예약 발송 부분취소 환불 (197-16). 게이트가 요구하는 조건을 충족해 허용에 추가한다:
      //  - 선점 CAS(cancelDeliveriesIfStillWaiting)가 NOT_CUTOVER_ORDER_DELIVERY 를 함께 싣는다
      //    → 전환·드레이닝 건은 affected=0 으로 취소 자체가 성립하지 않아 환불에 도달하지 못한다.
      //  - 환불은 그 CAS 성공(=legacy 점유 획득) 뒤에만 호출된다. 즉 refund_attempt 가 아니라
      //    "취소 선점" 이 종속 근거이며, 외부 API 취소 환불(#7)과 같은 형태다.
      'src/order/application/order.service.ts',
    ];

    const listCallers = (): string[] => {
      const srcRoot = path.join(__dirname, '..', '..');
      const projectRoot = path.join(srcRoot, '..');
      const found = new Set<string>();
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!entry.name.endsWith('.ts') || entry.name.includes('.spec.') || entry.name.includes('-test.')) {
            continue;
          }
          const body = fs.readFileSync(full, 'utf-8');
          if (/refundPoolService\.(refund|refundSettledDiscardToDeposit)\s*\(/.test(body)) {
            found.add(path.relative(projectRoot, full).split(path.sep).join('/'));
          }
        }
      };
      walk(srcRoot);
      return [...found].sort();
    };

    it('허용된 호출자 외에 신규 호출자가 없다', () => {
      const unexpected = listCallers().filter((f) => !ALLOWED_CALLERS.includes(f));

      expect(unexpected).toEqual([]);
    });
  });
});
