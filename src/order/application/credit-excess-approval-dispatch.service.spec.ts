import { BadRequestException } from '@nestjs/common';
import { CreditExcessApprovalDispatchService } from './credit-excess-approval-dispatch.service';
import {
  CreditExcessApprovalClaimConflictError,
  CreditExcessApprovalDriftError,
} from '../../wallet/application/credit-excess-approval.errors';
import { CreditExcessApprovalStatus } from '../../entity/credit.excess.approval.entity';

/**
 * [EP-P23] 승인 orchestration.
 * CAS 선점 → 발송확정 command → 실행 표식 기준 최종화/실패 분류/멱등 재호출 검증.
 */
describe('CreditExcessApprovalDispatchService', () => {
  const operator = { id: 9, email: 'op@example.com', authority: 'OPERATION_ADMIN' as any };

  const approvalRow = (overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      id: '900',
      orderId: 77,
      status: CreditExcessApprovalStatus.PENDING,
      requestedBy: 2,
      snapshot: { usage: { pointUseAmount: 0, depositUseEnabled: false, depositUseAmount: 0 } },
      userMessage: null,
      changedFields: null,
      diagnosticCode: null,
      ...overrides,
    }) as any;

  const makeService = ({
    initial = approvalRow(),
    finalRow,
    confirmImpl,
  }: {
    initial?: any;
    finalRow?: any;
    confirmImpl?: () => Promise<unknown>;
  } = {}) => {
    const states: any[] = [initial];
    const approvalService = {
      findOne: jest.fn(async () => states[states.length - 1]),
      claimForProcessing: jest.fn(async () => ({
        approval: { ...initial, status: CreditExcessApprovalStatus.PROCESSING },
        attemptToken: 'token-abc',
      })),
      finalizeCompleted: jest.fn(async () => {
        states.push(finalRow ?? approvalRow({ status: CreditExcessApprovalStatus.COMPLETED, userMessage: '완료' }));
      }),
      finalizeFailure: jest.fn(async (input: any) => {
        states.push(
          approvalRow({
            status: input.status,
            userMessage: input.userMessage,
            changedFields: input.changedFields,
            diagnosticCode: input.diagnosticCode,
          }),
        );
      }),
      reject: jest.fn(),
      toListItem: jest.fn(async (row: any) => ({ id: row.id, status: row.status })),
      list: jest.fn(),
      createPending: jest.fn(),
      findExpiredProcessing: jest.fn(),
      recoverExpired: jest.fn(),
    } as any;

    const orderService = {
      deliveryConfirmed: jest.fn(confirmImpl ?? (async () => ({ message: 'success' }))),
      buildCreditExcessApprovalRequest: jest.fn(),
    } as any;

    const userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 2, email: 'client@example.com', authority: 'CORPORATE_ADMIN' }),
    } as any;
    const approvalRepository = { manager: { transaction: jest.fn(async (cb: any) => cb({})) } } as any;

    const service = new CreditExcessApprovalDispatchService(
      orderService,
      approvalService,
      userRepository,
      approvalRepository,
    );
    return { service, approvalService, orderService, userRepository };
  };

  it('승인 1회로 발송확정을 실행하고 COMPLETED 로 최종화한다', async () => {
    const { service, approvalService, orderService } = makeService();

    const result = await service.approve(operator, '900', '10.0.0.1');

    expect(approvalService.claimForProcessing).toHaveBeenCalledWith('900', 9);
    const [actor, body, context] = orderService.deliveryConfirmed.mock.calls[0];
    // 발송확정은 요청자(과금 대상) 권한으로 실행되고, 승인자는 컨텍스트로 분리 전달된다.
    expect(actor).toEqual({ id: 2, email: 'client@example.com', authority: 'CORPORATE_ADMIN' });
    expect(body).toEqual({
      id: 77,
      pointUseAmount: undefined,
      depositUseEnabled: undefined,
      depositUseAmount: undefined,
    });
    expect(context).toMatchObject({
      approvalId: '900',
      attemptToken: 'token-abc',
      approverUserId: 9,
      requesterUserId: 2,
    });
    expect(approvalService.finalizeCompleted).toHaveBeenCalledWith('900', 'token-abc', expect.any(String));
    expect(result.status).toBe(CreditExcessApprovalStatus.COMPLETED);
  });

  it('스냅샷 불일치는 재요청 필요로 종료하고 변경 항목을 남긴다', async () => {
    const { service, approvalService } = makeService({
      confirmImpl: async () => {
        throw new CreditExcessApprovalDriftError(['결제 금액', '수신 대상'], 'snapshot mismatch');
      },
    });

    const result = await service.approve(operator, '900', '10.0.0.1');

    expect(approvalService.finalizeCompleted).not.toHaveBeenCalled();
    expect(approvalService.finalizeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        status: CreditExcessApprovalStatus.RE_REQUEST_REQUIRED,
        diagnosticCode: 'SNAPSHOT_MISMATCH',
        changedFields: ['결제 금액', '수신 대상'],
      }),
    );
    expect(result.status).toBe(CreditExcessApprovalStatus.RE_REQUEST_REQUIRED);
    expect(result.userMessage).toContain('결제 금액');
  });

  it('주문 상태 변경은 재요청 필요로 분류한다', async () => {
    const { service, approvalService } = makeService({
      confirmImpl: async () => {
        throw new BadRequestException('해당 주문건은 존재하지 않거나, 검토완료 상태가 아닙니다.');
      },
    });

    const result = await service.approve(operator, '900', '10.0.0.1');

    expect(approvalService.finalizeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        status: CreditExcessApprovalStatus.RE_REQUEST_REQUIRED,
        diagnosticCode: 'ORDER_STATE_CHANGED',
      }),
    );
    expect(result.changedFields).toEqual(['주문 상태']);
  });

  it('시스템 오류는 성공 승인으로 남기지 않고 FAILED 로 기록한다', async () => {
    const { service, approvalService } = makeService({
      confirmImpl: async () => {
        throw new Error('allocation persist DB down');
      },
    });

    const result = await service.approve(operator, '900', '10.0.0.1');

    expect(approvalService.finalizeCompleted).not.toHaveBeenCalled();
    expect(approvalService.finalizeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        status: CreditExcessApprovalStatus.FAILED,
        diagnosticCode: 'DISPATCH_FAILED',
        internalReason: 'allocation persist DB down',
      }),
    );
    expect(result.status).toBe(CreditExcessApprovalStatus.FAILED);
  });

  it.each([
    CreditExcessApprovalStatus.PROCESSING,
    CreditExcessApprovalStatus.COMPLETED,
    CreditExcessApprovalStatus.FAILED,
    CreditExcessApprovalStatus.REJECTED,
    CreditExcessApprovalStatus.EXPIRED,
  ])('%s 상태 재호출은 확정을 다시 실행하지 않고 현재 결과를 반환한다', async (status) => {
    const { service, approvalService, orderService } = makeService({ initial: approvalRow({ status }) });

    const result = await service.approve(operator, '900', '10.0.0.1');

    expect(result.status).toBe(status);
    expect(approvalService.claimForProcessing).not.toHaveBeenCalled();
    expect(orderService.deliveryConfirmed).not.toHaveBeenCalled();
  });

  it('동시 승인에서 선점에 밀린 요청은 400 대신 현재 상태를 멱등 반환한다', async () => {
    // 두 요청 모두 PENDING 을 읽는다(사전 조회 통과). 승자가 PROCESSING 으로 전이하면
    // 패자의 claimForProcessing 은 conflict 로 실패한다 — 이때 최신 상태를 그대로 반환해야 한다.
    const { service, approvalService, orderService } = makeService();
    approvalService.claimForProcessing.mockRejectedValueOnce(
      new CreditExcessApprovalClaimConflictError(
        approvalRow({ status: CreditExcessApprovalStatus.PROCESSING, userMessage: '발송확정을 처리하는 중입니다.' }),
      ),
    );

    const result = await service.approve(operator, '900', '10.0.0.1');

    expect(result.status).toBe(CreditExcessApprovalStatus.PROCESSING);
    expect(orderService.deliveryConfirmed).not.toHaveBeenCalled();
    expect(approvalService.finalizeCompleted).not.toHaveBeenCalled();
    expect(approvalService.finalizeFailure).not.toHaveBeenCalled();
  });

  it('lease 복구는 상태 저장소의 표식 판정 결과만 집계한다', async () => {
    const { service, approvalService } = makeService();
    approvalService.findExpiredProcessing.mockResolvedValue([{ id: '900' }, { id: '901' }]);
    approvalService.recoverExpired
      .mockResolvedValueOnce(CreditExcessApprovalStatus.COMPLETED)
      .mockResolvedValueOnce(null);

    await expect(service.recoverExpiredLeases()).resolves.toBe(1);
  });
});
