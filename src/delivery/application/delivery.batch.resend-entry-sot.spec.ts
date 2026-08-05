import { DeliveryBatchService } from './delivery.batch.service';
import { DeliveryCutoverGuardService } from './delivery-cutover-guard.service';
import { DeliveryWorkflowStatus } from '../interface/delivery.workflow.status';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';

/**
 * HIGH 4 — 발송 진입점의 "실패 재발송인가" 판정 SoT 고정 (§8).
 *
 * 이 값 하나가 배타 op(MANUAL_RESEND/MESSAGE_SEND)·시도 유형·환불 복구(reverseRefundForResend)·
 * RESEND attempt 선발급·재실패 재환불을 전부 좌우한다. 뒤집히면 환불이 누락되거나 없는 환불을
 * 되감으므로, 전환 여부에 따라 근거가 정확히 하나여야 한다.
 *
 *  - 미전환 건: `order_delivery.status` 가 실제 SoT (종전 동작 그대로)
 *  - 전환 건  : `status` 는 표시용 미러 → `delivery_workflow.workflow_status` 만 근거
 */
describe('발송 진입점 재발송 판정 SoT', () => {
  const buildSut = (workflowVerdict: boolean | null) => {
    const isWorkflowResend = jest.fn().mockResolvedValue(workflowVerdict);
    const sut: any = Object.create(DeliveryBatchService.prototype);
    sut.cutoverGuard = { isWorkflowResend };
    return { sut, isWorkflowResend };
  };

  const od = (status: IOrderDeliveryStatus) => ({ id: 501, status }) as never;

  describe('미전환 건 — legacy status 가 SoT', () => {
    it.each([
      [IOrderDeliveryStatus.FAIL, true],
      [IOrderDeliveryStatus.FAIL_SMS, true],
      [IOrderDeliveryStatus.WAIT, false],
      [IOrderDeliveryStatus.COMPLETE, false],
      [IOrderDeliveryStatus.COMPLETE_SMS, false],
    ])('status=%s → 재발송=%s', async (status, expected) => {
      const { sut } = buildSut(null);

      await expect(sut.resolveResendEntry(od(status))).resolves.toBe(expected);
    });
  });

  describe('전환 건 — workflow 업무 상태가 SoT', () => {
    it('workflow 가 재발송이라고 하면 legacy status 가 COMPLETE 여도 재발송이다', async () => {
      const { sut, isWorkflowResend } = buildSut(true);

      await expect(sut.resolveResendEntry(od(IOrderDeliveryStatus.COMPLETE))).resolves.toBe(true);
      expect(isWorkflowResend).toHaveBeenCalledWith(501);
    });

    it('workflow 가 최초 발송이라고 하면 legacy status 가 FAIL 이어도 최초 발송이다', async () => {
      const { sut } = buildSut(false);

      // 컷오버 마크가 서면 status 는 파생 미러다. 미러를 따라가면 있지도 않은 환불을 되감는다.
      await expect(sut.resolveResendEntry(od(IOrderDeliveryStatus.FAIL))).resolves.toBe(false);
    });
  });
});

/**
 * 판정 근거 자체(cutover guard)의 계약 — 전환 여부와 workflow 상태 매핑.
 */
describe('DeliveryCutoverGuardService.isWorkflowResend', () => {
  const buildGuard = (workflow: Record<string, unknown> | null) => {
    const findOne = jest.fn().mockResolvedValue(workflow);
    const guard = new DeliveryCutoverGuardService({ findOne } as never, {} as never);
    return { guard, findOne };
  };

  it('workflow 행이 없으면 null — 호출자가 legacy status 로 판단한다', async () => {
    const { guard } = buildGuard(null);

    await expect(guard.isWorkflowResend(501)).resolves.toBeNull();
  });

  it('전환 마크가 없으면 null — shadow 단계 전 건은 종전 동작을 유지한다', async () => {
    const { guard } = buildGuard({
      workflowStatus: DeliveryWorkflowStatus.FAILED_FINAL,
      cutoverMigratedAt: null,
    });

    await expect(guard.isWorkflowResend(501)).resolves.toBeNull();
  });

  it.each([
    [DeliveryWorkflowStatus.FAILED_FINAL, true],
    [DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED, true],
    [DeliveryWorkflowStatus.RESOLVED_MANUALLY_FAILED, true],
    // 미확정은 아직 실패가 아니다 — 재발송으로 취급하면 이중 발송이 된다.
    [DeliveryWorkflowStatus.PENDING_RECONCILE, false],
    [DeliveryWorkflowStatus.IN_PROGRESS, false],
    [DeliveryWorkflowStatus.COMPLETED, false],
    [DeliveryWorkflowStatus.CANCELLED, false],
    [DeliveryWorkflowStatus.RESOLVED_MANUALLY_SUCCESS, false],
    [DeliveryWorkflowStatus.RESOLVED_MANUALLY_REFUNDED, false],
  ])('전환 건 workflow=%s → 재발송=%s', async (workflowStatus, expected) => {
    const { guard } = buildGuard({ workflowStatus, cutoverMigratedAt: new Date() });

    await expect(guard.isWorkflowResend(501)).resolves.toBe(expected);
  });
});
