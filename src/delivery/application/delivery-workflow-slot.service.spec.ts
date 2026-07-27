import {
  ALLOWED_WORKFLOW_STATUSES,
  DeliveryWorkflowSlotService,
  DUAL_REQUIRED_OPS,
} from './delivery-workflow-slot.service';
import {
  DeliveryExclusiveOp,
  DeliverySlotFailureCode,
  DeliveryWorkflowStatus,
} from '../interface/delivery.workflow.status';
import { MessageAttemptStatus } from '../interface/message.attempt.status';

/**
 * Level A 배타 슬롯 계약.
 * plans/프리미엄_발송실패_재발송_구상.md §6.1(표 2-1·가드) / §6.2(조건부 UPDATE·실패 원인 구분).
 */
describe('DeliveryWorkflowSlotService — Level A 배타 슬롯', () => {
  const orderDeliveryId = 1234;

  const createService = (options: { affected?: number; row?: Record<string, unknown> | null } = {}) => {
    const conditions: { sql: string; params?: Record<string, unknown> }[] = [];
    const setValues: Record<string, unknown>[] = [];

    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockImplementation((values) => {
        setValues.push(values);
        return qb;
      }),
      where: jest.fn().mockImplementation((sql, params) => {
        conditions.push({ sql, params });
        return qb;
      }),
      andWhere: jest.fn().mockImplementation((sql, params) => {
        conditions.push({ sql, params });
        return qb;
      }),
      execute: jest.fn().mockResolvedValue({ affected: options.affected ?? 1 }),
    };

    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn().mockImplementation(async () => {
        if (options.row === undefined) {
          // 점유 성공 경로: 갱신 후 소유자 조회. 토큰은 SET 절에 실린 값을 그대로 돌려준다.
          const last = setValues[setValues.length - 1] ?? {};
          return { orderDeliveryId, workflowVersion: '8', exclusiveOwnerToken: last.exclusiveOwnerToken };
        }
        return options.row;
      }),
    } as never;

    return { service: new DeliveryWorkflowSlotService(repository), conditions, setValues };
  };

  const sqlOf = (conditions: { sql: string }[]) => conditions.map((c) => c.sql).join(' | ');

  describe('표 2-1 — op 별 허용 workflow 상태', () => {
    it('발송·재시도·최초 PIN 발급 계열은 종결 상태를 허용하지 않는다', () => {
      for (const op of [DeliveryExclusiveOp.MESSAGE_SEND, DeliveryExclusiveOp.PIN_ISSUE, DeliveryExclusiveOp.RETRY]) {
        expect(ALLOWED_WORKFLOW_STATUSES[op]).toEqual([
          DeliveryWorkflowStatus.IN_PROGRESS,
          DeliveryWorkflowStatus.PENDING_RECONCILE,
        ]);
      }
    });

    it('PIN_REISSUE 는 OPS_REVIEW_REQUIRED 단일 — FAILED_FINAL 직접 재발급을 막는다', () => {
      expect(ALLOWED_WORKFLOW_STATUSES[DeliveryExclusiveOp.PIN_REISSUE]).toEqual([
        DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
      ]);
    });

    it('REFUND 는 이미 환불이 확정된 RESOLVED_MANUALLY_REFUNDED 를 제외한다(중복 환불 차단)', () => {
      expect(ALLOWED_WORKFLOW_STATUSES[DeliveryExclusiveOp.REFUND]).not.toContain(
        DeliveryWorkflowStatus.RESOLVED_MANUALLY_REFUNDED,
      );
    });

    it('MANUAL_RESEND 는 FAILED_FINAL·OPS_REVIEW_REQUIRED 에서만 — RESOLVED_MANUALLY_* 는 불변이라 대상 아님', () => {
      expect(ALLOWED_WORKFLOW_STATUSES[DeliveryExclusiveOp.MANUAL_RESEND]).toEqual([
        DeliveryWorkflowStatus.FAILED_FINAL,
        DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
      ]);
    });
  });

  describe('점유 조건부 UPDATE', () => {
    it('슬롯 공석/만료 + op 허용 상태 + workflow_version+1 을 한 번의 UPDATE 로 건다', async () => {
      const { service, conditions, setValues } = createService();

      const result = await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.MESSAGE_SEND });

      expect(result.acquired).toBe(true);
      expect(sqlOf(conditions)).toContain('active_exclusive_op IS NULL OR exclusive_lease_expires_at <');
      expect(conditions[1].params?.allowedStatuses).toEqual(
        ALLOWED_WORKFLOW_STATUSES[DeliveryExclusiveOp.MESSAGE_SEND],
      );
      expect(setValues[0].workflowVersion).toBeInstanceOf(Function);
    });

    it('MESSAGE_SEND 가드는 UNKNOWN·RETRY_SCHEDULED 를 포함한 미확정 시도 부재를 요구한다', async () => {
      const { service, conditions } = createService();

      await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.MESSAGE_SEND });

      const guard = conditions.find((c) => c.sql.includes('NOT EXISTS') && c.sql.includes('message_attempt'));
      expect(guard).toBeDefined();
      expect(guard!.params?.messageSendBlocking).toContain(MessageAttemptStatus.UNKNOWN);
      expect(guard!.params?.messageSendBlocking).toContain(MessageAttemptStatus.RETRY_SCHEDULED);
    });

    it('RETRY(메시지 변형) 가드는 RETRY_SCHEDULED 를 제외 집합에 두지 않는다(실행 대상이므로)', async () => {
      const { service, conditions } = createService();

      await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.RETRY });

      const guard = conditions.find((c) => c.params?.messageRetryBlocking);
      expect(guard!.params?.messageRetryBlocking).not.toContain(MessageAttemptStatus.RETRY_SCHEDULED);
      expect(guard!.sql).toContain('next_attempt_at <= :now');
    });

    it('PIN_ISSUE 는 발급 명령이 하나라도 있으면 점유하지 못한다(재시도=RETRY, 재발급=PIN_REISSUE)', async () => {
      const { service, conditions } = createService();

      await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.PIN_ISSUE });

      expect(sqlOf(conditions)).toContain('NOT EXISTS (SELECT 1 FROM pin_issue_command pc WHERE pc.order_delivery_id');
    });

    it('MANUAL_RESEND 는 환불 가드(refunded_at·refund_status)를 WHERE 에 포함한다', async () => {
      const { service, conditions } = createService();

      await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.MANUAL_RESEND });

      expect(sqlOf(conditions)).toContain('refunded_at IS NULL AND refund_status IS NULL');
    });

    it('REFUND 는 미확정 refund_attempt 가 있으면 점유하지 못한다(단일 in-flight)', async () => {
      const { service, conditions } = createService();

      await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.REFUND });

      const guard = conditions.find((c) => c.sql.includes('refund_attempt'));
      expect(guard!.sql).toContain("'CLAIMED','SUBMITTING','RECONCILING','UNKNOWN'");
    });

    it('DUAL op 는 승인 바인딩 없이는 DB 를 건드리지 않고 거부한다', async () => {
      for (const op of DUAL_REQUIRED_OPS) {
        const { service, conditions } = createService();

        const result = await service.acquire({ orderDeliveryId, op });

        expect(result).toEqual({ acquired: false, code: DeliverySlotFailureCode.DELIVERY_OPERATION_NOT_ALLOWED });
        expect(conditions).toHaveLength(0);
      }
    });

    it('DUAL op 는 승인 5개 조건(id·op·delivery·바인딩 버전·APPROVED)을 같은 UPDATE 에서 검증한다', async () => {
      const { service, conditions } = createService();

      await service.acquire({
        orderDeliveryId,
        op: DeliveryExclusiveOp.OPS_RESOLVE,
        approval: { approvalId: '77', payloadHash: 'h'.repeat(64), boundWorkflowVersion: '8' },
      });

      const approvalCondition = conditions.find((c) => c.sql.includes('dual_approval'));
      expect(approvalCondition!.sql).toContain('a.id = :approvalId');
      expect(approvalCondition!.sql).toContain('a.op = :approvalOp');
      expect(approvalCondition!.sql).toContain('a.order_delivery_id = :orderDeliveryId');
      expect(approvalCondition!.sql).toContain('a.bound_workflow_version = :boundWorkflowVersion');
      expect(approvalCondition!.sql).toContain("a.status = 'APPROVED'");
      // 승인이 바인딩한 버전과 현재 버전이 어긋나면 점유 자체가 실패해야 한다(재승인 요구).
      expect(sqlOf(conditions)).toContain('workflow_version = :boundWorkflowVersion');
    });
  });

  describe('affected=0 실패 원인 구분 (§6.2)', () => {
    const now = new Date('2026-07-27T10:00:00+09:00');

    it('다른 배타 작업이 유효 lease 로 점유 중이면 LOCKED (재시도 가능)', async () => {
      const { service } = createService({
        affected: 0,
        row: {
          workflowStatus: DeliveryWorkflowStatus.IN_PROGRESS,
          activeExclusiveOp: DeliveryExclusiveOp.REFUND,
          exclusiveLeaseExpiresAt: new Date(now.getTime() + 60_000),
        },
      });

      const result = await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.MESSAGE_SEND, now });

      expect(result).toMatchObject({
        acquired: false,
        code: DeliverySlotFailureCode.DELIVERY_OPERATION_LOCKED,
        activeOp: DeliveryExclusiveOp.REFUND,
      });
    });

    it('op 허용 상태가 아니면 NOT_ALLOWED (상태 충돌 — 재시도 무의미)', async () => {
      const { service } = createService({
        affected: 0,
        row: {
          workflowStatus: DeliveryWorkflowStatus.COMPLETED,
          activeExclusiveOp: null,
          exclusiveLeaseExpiresAt: null,
        },
      });

      const result = await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.MESSAGE_SEND, now });

      expect(result).toMatchObject({
        acquired: false,
        code: DeliverySlotFailureCode.DELIVERY_OPERATION_NOT_ALLOWED,
        workflowStatus: DeliveryWorkflowStatus.COMPLETED,
      });
    });

    it('허용 상태인데 가드에 걸린 발송 계열은 RECONCILE_IN_PROGRESS', async () => {
      const { service } = createService({
        affected: 0,
        row: {
          workflowStatus: DeliveryWorkflowStatus.PENDING_RECONCILE,
          activeExclusiveOp: null,
          exclusiveLeaseExpiresAt: null,
        },
      });

      const result = await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.MESSAGE_SEND, now });

      expect(result).toMatchObject({ code: DeliverySlotFailureCode.DELIVERY_RECONCILE_IN_PROGRESS });
    });

    it('환불이 있는 MANUAL_RESEND 는 REFUND_BLOCKS_RESEND', async () => {
      const { service } = createService({
        affected: 0,
        row: {
          workflowStatus: DeliveryWorkflowStatus.FAILED_FINAL,
          activeExclusiveOp: null,
          exclusiveLeaseExpiresAt: null,
          refundedAt: new Date(),
        },
      });

      const result = await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.MANUAL_RESEND, now });

      expect(result).toMatchObject({ code: DeliverySlotFailureCode.DELIVERY_REFUND_BLOCKS_RESEND });
    });

    it('예약이 없는 CANCEL_RESEND 는 RESEND_NOT_SCHEDULED, 대상 없는 CANCEL_INFLIGHT_SEND 는 NO_INFLIGHT_SEND', async () => {
      const row = {
        workflowStatus: DeliveryWorkflowStatus.IN_PROGRESS,
        activeExclusiveOp: null,
        exclusiveLeaseExpiresAt: null,
      };

      const cancelResend = await createService({ affected: 0, row }).service.acquire({
        orderDeliveryId,
        op: DeliveryExclusiveOp.CANCEL_RESEND,
        now,
      });
      const cancelInflight = await createService({ affected: 0, row }).service.acquire({
        orderDeliveryId,
        op: DeliveryExclusiveOp.CANCEL_INFLIGHT_SEND,
        now,
      });

      expect(cancelResend).toMatchObject({ code: DeliverySlotFailureCode.DELIVERY_RESEND_NOT_SCHEDULED });
      expect(cancelInflight).toMatchObject({ code: DeliverySlotFailureCode.DELIVERY_NO_INFLIGHT_SEND });
    });

    it('대상 workflow 가 없으면 WORKFLOW_NOT_FOUND', async () => {
      const { service } = createService({ affected: 0, row: null });

      const result = await service.acquire({ orderDeliveryId, op: DeliveryExclusiveOp.MESSAGE_SEND, now });

      expect(result).toMatchObject({ code: DeliverySlotFailureCode.DELIVERY_WORKFLOW_NOT_FOUND });
    });
  });

  describe('해제·heartbeat fencing', () => {
    const slot = {
      orderDeliveryId,
      op: DeliveryExclusiveOp.MESSAGE_SEND,
      ownerToken: 'token-1',
      workflowVersion: '8',
      leaseExpiresAt: new Date(),
    };

    it('해제는 op·소유토큰·workflow_version 을 모두 조건으로 건다', async () => {
      const { service, conditions } = createService();

      await service.release(slot);

      expect(sqlOf(conditions)).toContain('active_exclusive_op = :op');
      expect(sqlOf(conditions)).toContain('exclusive_owner_token = :ownerToken');
      expect(sqlOf(conditions)).toContain('workflow_version = :workflowVersion');
    });

    it('이미 회수돼 새 소유자가 점유했으면(affected=0) 남의 슬롯을 해제하지 않는다(ABA)', async () => {
      const { service } = createService({ affected: 0, row: null });

      await expect(service.release(slot)).resolves.toBe(false);
    });

    it('heartbeat 도 fencing 불일치면 연장하지 않는다', async () => {
      const { service } = createService({ affected: 0, row: null });

      await expect(service.heartbeat(slot)).resolves.toBe(false);
    });
  });
});
