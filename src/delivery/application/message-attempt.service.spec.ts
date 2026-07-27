import { ConflictException } from '@nestjs/common';
import { MessageAttemptService, formatYearMonth } from './message-attempt.service';
import { MessageAttemptChannel, MessageAttemptStatus, MessageAttemptType } from '../interface/message.attempt.status';
import { DeliveryExclusiveOp, DeliverySlotFailureCode, LEGACY_SEND_OP } from '../interface/delivery.workflow.status';
import { isValidAttemptId } from '../domain/message.attempt.id';

/**
 * outbox 2단 마크 + 컷오버 게이트 검증.
 * plans/프리미엄_발송실패_재발송_구상.md §5.3 / §9(단일 동시성 모델·전환 마크) / §10 2단계.
 */
describe('MessageAttemptService — 시도 추적(outbox 2단 마크)', () => {
  const orderDeliveryId = 4242;

  const createService = (
    overrides: {
      save?: jest.Mock;
      update?: jest.Mock;
      findOne?: jest.Mock;
      cutoverMigratedAt?: Date | null;
      acquire?: jest.Mock;
      release?: jest.Mock;
      ensureWorkflow?: jest.Mock;
    } = {},
  ) => {
    const saved: Record<string, unknown>[] = [];
    const save =
      overrides.save ??
      jest.fn().mockImplementation((entity) => {
        saved.push({ ...entity });
        return Promise.resolve(entity);
      });
    const update = overrides.update ?? jest.fn().mockResolvedValue({ affected: 1 });
    const findOne = overrides.findOne ?? jest.fn().mockResolvedValue(null);

    const attemptRepository = {
      create: jest.fn().mockImplementation((entity) => ({ ...entity })),
      save,
      update,
      findOne,
    } as never;

    const acquire =
      overrides.acquire ??
      jest.fn().mockResolvedValue({
        acquired: true,
        slot: {
          orderDeliveryId,
          op: DeliveryExclusiveOp.MESSAGE_SEND,
          ownerToken: 'token-1',
          workflowVersion: '9',
          leaseExpiresAt: new Date(),
        },
      });
    const release = overrides.release ?? jest.fn().mockResolvedValue(true);
    const ensureWorkflow =
      overrides.ensureWorkflow ??
      jest.fn().mockResolvedValue({
        orderDeliveryId,
        workflowVersion: '7',
        cutoverMigratedAt: overrides.cutoverMigratedAt ?? null,
      });

    const slotService = { ensureWorkflow, acquire, release } as never;

    return {
      service: new MessageAttemptService(attemptRepository, slotService),
      saved,
      save,
      update,
      findOne,
      acquire,
      release,
    };
  };

  const ctx = (override = {}) => ({
    orderDeliveryId,
    channel: MessageAttemptChannel.MMS,
    attemptType: MessageAttemptType.INITIAL,
    slotOp: DeliveryExclusiveOp.MESSAGE_SEND,
    sendReason: 'COUPON',
    ...override,
  });

  describe('미전환 건 — legacy claim 이 단일 동시성 모델(§9)', () => {
    it('슬롯을 점유하지 않고 관찰만 하며 생성 출처를 LEGACY_SEND 로 남긴다', async () => {
      const { service, saved, acquire, release } = createService();

      await service.trackSend(ctx(), async () => ({ mseq: 55, recovered: false }));

      expect(acquire).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(saved[0]).toMatchObject({ createdByOp: LEGACY_SEND_OP, createdWorkflowVersion: '7', ownerToken: null });
    });

    it('외부 호출 전에 OUTBOX_READY 를 커밋하고 SUBMITTING 마크 뒤에만 발송한다', async () => {
      const { service, saved, update } = createService();
      const callOrder: string[] = [];
      update.mockImplementation((_criteria, patch) => {
        callOrder.push(`update:${patch.status}`);
        return Promise.resolve({ affected: 1 });
      });

      await service.trackSend(ctx(), async (attemptId) => {
        callOrder.push(`send:${attemptId}`);
        return { mseq: 55, recovered: false };
      });

      expect(saved[0]).toMatchObject({ status: MessageAttemptStatus.OUTBOX_READY, retryOfAttemptId: null });
      expect(saved[0].rootAttemptId).toEqual(saved[0].attemptId);
      expect(isValidAttemptId(saved[0].attemptId as string)).toBe(true);
      expect(callOrder).toEqual([
        `update:${MessageAttemptStatus.SUBMITTING}`,
        `send:${saved[0].attemptId}`,
        `update:${MessageAttemptStatus.TRACKING}`,
      ]);
    });

    it('추적이 실패해도 발송은 상관키 없이 그대로 수행된다(shadow 무해성)', async () => {
      const { service } = createService({ save: jest.fn().mockRejectedValue(new Error('db down')) });
      const send = jest.fn().mockResolvedValue({ mseq: null, recovered: false });

      await expect(service.trackSend(ctx(), send)).resolves.toEqual({ mseq: null, recovered: false });
      expect(send).toHaveBeenCalledWith(undefined);
    });
  });

  describe('전환 건 — Level A 슬롯 강제(fail-closed)', () => {
    const cutoverMigratedAt = new Date('2026-07-27T00:00:00+09:00');

    it('수동 재발송은 MANUAL_RESEND 슬롯을 점유하고 생성 출처도 그 op 로 기록한다', async () => {
      const { service, saved, acquire } = createService({ cutoverMigratedAt });

      await service.trackSend(
        ctx({ slotOp: DeliveryExclusiveOp.MANUAL_RESEND, attemptType: MessageAttemptType.MANUAL_RESEND }),
        async () => ({ mseq: 3, recovered: false }),
      );

      // MESSAGE_SEND 로 점유하면 FAILED_FINAL/OPS_REVIEW_REQUIRED 가 허용 상태가 아니라 409 로 막힌다.
      expect(acquire).toHaveBeenCalledWith(
        expect.objectContaining({ op: DeliveryExclusiveOp.MANUAL_RESEND, approval: undefined }),
      );
      expect(saved[0]).toMatchObject({ createdByOp: DeliveryExclusiveOp.MANUAL_RESEND, approvalId: null });
    });

    it('DUAL 승인 바인딩을 슬롯 점유에 전달하고 생성 행에 승인 id 를 남긴다', async () => {
      const { service, saved, acquire } = createService({ cutoverMigratedAt });
      const approval = { approvalId: '77', payloadHash: 'h'.repeat(64), boundWorkflowVersion: '9' };

      await service.trackSend(
        ctx({ slotOp: DeliveryExclusiveOp.MANUAL_RESEND, attemptType: MessageAttemptType.MANUAL_RESEND, approval }),
        async () => ({ mseq: 3, recovered: false }),
      );

      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ approval }));
      expect(saved[0]).toMatchObject({ approvalId: '77' });
    });

    it('슬롯을 점유한 뒤 발송하고, 끝나면 fencing 해제한다', async () => {
      const { service, saved, acquire, release } = createService({ cutoverMigratedAt });
      const send = jest.fn().mockResolvedValue({ mseq: 7, recovered: false });

      await service.trackSend(ctx({ slotOp: DeliveryExclusiveOp.MESSAGE_SEND }), send);

      expect(acquire).toHaveBeenCalledWith(
        expect.objectContaining({ orderDeliveryId, op: DeliveryExclusiveOp.MESSAGE_SEND }),
      );
      expect(send).toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(expect.objectContaining({ ownerToken: 'token-1' }));
      // 슬롯 세대에 바인딩된 값으로 기록해야 3중 fencing 이 성립한다.
      expect(saved[0]).toMatchObject({
        createdByOp: DeliveryExclusiveOp.MESSAGE_SEND,
        createdWorkflowVersion: '9',
        workflowVersion: '9',
        ownerToken: 'token-1',
      });
    });

    it('슬롯을 얻지 못하면 발송하지 않고 409 로 거부한다(legacy 진입 거부)', async () => {
      const acquire = jest.fn().mockResolvedValue({
        acquired: false,
        code: DeliverySlotFailureCode.DELIVERY_OPERATION_LOCKED,
      });
      const { service, release } = createService({ cutoverMigratedAt, acquire });
      const send = jest.fn();

      await expect(service.trackSend(ctx(), send)).rejects.toBeInstanceOf(ConflictException);
      expect(send).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    });

    it('추적 행을 만들지 못하면 발송하지 않고 슬롯을 해제한다(미추적 발송 차단)', async () => {
      const { service, release } = createService({
        cutoverMigratedAt,
        save: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const send = jest.fn();

      await expect(service.trackSend(ctx(), send)).rejects.toThrow('db down');
      expect(send).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
    });

    it('발송이 실패해도 슬롯은 반드시 해제한다', async () => {
      const { service, release } = createService({ cutoverMigratedAt });

      await expect(service.trackSend(ctx(), async () => Promise.reject(new Error('gemtek down')))).rejects.toThrow(
        'gemtek down',
      );
      expect(release).toHaveBeenCalled();
    });
  });

  describe('결과 반영', () => {
    it('MSEQ 를 확보하면 TRACKING 으로 등록하고 접수월 커서를 남긴다', async () => {
      const { service, update } = createService();

      await service.trackSend(ctx(), async () => ({ mseq: 91, recovered: false }));

      const [, [criteria, patch]] = update.mock.calls;
      expect(criteria).toMatchObject({ status: MessageAttemptStatus.SUBMITTING });
      expect(patch).toMatchObject({
        status: MessageAttemptStatus.TRACKING,
        mseq: '91',
        receiptMonth: formatYearMonth(new Date()),
        nextSearchMonth: formatYearMonth(new Date()),
      });
    });

    it('MSEQ 를 확보하지 못하면 SUBMITTED 로 남겨 재조정 대상이 되게 한다', async () => {
      const { service, update } = createService();

      await service.trackSend(ctx(), async () => ({ mseq: null, recovered: false }));

      expect(update.mock.calls[1][1]).toMatchObject({ status: MessageAttemptStatus.SUBMITTED, mseq: null });
    });

    it('외부 호출이 실패하면 RECONCILING 으로만 전환하고 오류를 그대로 전파한다(재삽입 금지)', async () => {
      const { service, update } = createService();
      const failure = new Error('gemtek down');

      await expect(service.trackSend(ctx(), async () => Promise.reject(failure))).rejects.toBe(failure);

      expect(update.mock.calls[1][1]).toMatchObject({ status: MessageAttemptStatus.RECONCILING });
    });
  });

  describe('알림톡 추적 — 폴백 체인 부모 확보(§5.3 CHANNEL_FALLBACK unique)', () => {
    it('접수 성공(A000)은 미확정(TRACKING)으로 남긴다', async () => {
      const { service, saved, update } = createService();

      await service.trackAlimTalk(
        {
          orderDeliveryId,
          slotOp: DeliveryExclusiveOp.MESSAGE_SEND,
          attemptType: MessageAttemptType.INITIAL,
          sendReason: 'COUPON',
        },
        async () => ({ report: { code: 'A000' } }),
        (result) => result.report.code === 'A000',
      );

      expect(saved[0]).toMatchObject({ channel: MessageAttemptChannel.ALIM_TALK });
      expect(update.mock.calls[1][1]).toMatchObject({ status: MessageAttemptStatus.TRACKING });
    });

    it('접수 실패는 FAILED_FINAL 로 확정해 폴백 SMS 가 부모로 잡을 수 있게 한다', async () => {
      const { service, update } = createService();

      await service.trackAlimTalk(
        { orderDeliveryId, slotOp: DeliveryExclusiveOp.MESSAGE_SEND, attemptType: MessageAttemptType.INITIAL },
        async () => ({ report: { code: 'A999' } }),
        (result) => result.report.code === 'A000',
      );

      expect(update.mock.calls[1][1]).toMatchObject({ status: MessageAttemptStatus.FAILED_FINAL });
    });

    it('전송 예외도 실패로 확정하고 오류를 전파한다', async () => {
      const { service, update } = createService();
      const failure = new Error('info bank down');

      await expect(
        service.trackAlimTalk(
          { orderDeliveryId, slotOp: DeliveryExclusiveOp.MESSAGE_SEND, attemptType: MessageAttemptType.INITIAL },
          async () => Promise.reject(failure),
          () => true,
        ),
      ).rejects.toBe(failure);

      expect(update.mock.calls[1][1]).toMatchObject({ status: MessageAttemptStatus.FAILED_FINAL });
    });

    it('폴백 SMS 는 직전 알림톡 시도를 체인 부모로 연결한다(rootAttemptId 상속)', async () => {
      const parent = { attemptId: 'a'.repeat(32), rootAttemptId: 'r'.repeat(32), attemptSeq: 1 };
      const { service, saved } = createService({ findOne: jest.fn().mockResolvedValue(parent) });

      await service.trackSend(ctx({ attemptType: MessageAttemptType.CHANNEL_FALLBACK }), async () => ({
        mseq: 1,
        recovered: false,
      }));

      expect(saved[0]).toMatchObject({
        attemptType: MessageAttemptType.CHANNEL_FALLBACK,
        retryOfAttemptId: parent.attemptId,
        rootAttemptId: parent.rootAttemptId,
        attemptSeq: 2,
      });
    });
  });

  it('테스트 발송은 추적하지 않고 workflow 도 만들지 않는다', async () => {
    const ensureWorkflow = jest.fn();
    const { service, save } = createService({ ensureWorkflow });
    const send = jest.fn().mockResolvedValue({ mseq: null, recovered: false });

    await service.trackSend(ctx({ skipTracking: true }), send);

    expect(ensureWorkflow).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(undefined);
  });
});
