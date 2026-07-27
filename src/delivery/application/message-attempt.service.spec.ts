import { MessageAttemptService, formatYearMonth } from './message-attempt.service';
import { MessageAttemptChannel, MessageAttemptStatus, MessageAttemptType } from '../interface/message.attempt.status';
import { DeliveryExclusiveOp } from '../interface/delivery.workflow.status';
import { isValidAttemptId } from '../domain/message.attempt.id';

/**
 * outbox 2단 마크(OUTBOX_READY → SUBMITTING → SUBMITTED/TRACKING) 검증.
 * plans/프리미엄_발송실패_재발송_구상.md §5.3 / §10 2단계(shadow 추적 무해성).
 */
describe('MessageAttemptService — 시도 추적(outbox 2단 마크)', () => {
  const orderDeliveryId = 4242;

  const createService = (overrides: { save?: jest.Mock; update?: jest.Mock; findOne?: jest.Mock } = {}) => {
    const saved: Record<string, unknown>[] = [];
    const save =
      overrides.save ??
      jest.fn().mockImplementation((entity) => {
        saved.push(entity);
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

    const slotService = {
      ensureWorkflow: jest.fn().mockResolvedValue({ orderDeliveryId, workflowVersion: '7' }),
    } as never;

    return { service: new MessageAttemptService(attemptRepository, slotService), saved, save, update, findOne };
  };

  const ctx = (override = {}) => ({
    orderDeliveryId,
    channel: MessageAttemptChannel.MMS,
    attemptType: MessageAttemptType.INITIAL,
    sendReason: 'COUPON',
    ...override,
  });

  it('외부 호출 전에 OUTBOX_READY 를 커밋하고 SUBMITTING 마크 뒤에만 발송한다', async () => {
    const { service, saved, update } = createService();
    const callOrder: string[] = [];
    update.mockImplementation((criteria, patch) => {
      callOrder.push(`update:${patch.status}`);
      return Promise.resolve({ affected: 1 });
    });

    await service.trackSend(ctx(), async (attemptId) => {
      callOrder.push(`send:${attemptId}`);
      return { mseq: 55, recovered: false };
    });

    expect(saved[0]).toMatchObject({
      status: MessageAttemptStatus.OUTBOX_READY,
      createdByOp: DeliveryExclusiveOp.MESSAGE_SEND,
      createdWorkflowVersion: '7',
      retryOfAttemptId: null,
    });
    expect(saved[0].rootAttemptId).toEqual(saved[0].attemptId);
    expect(isValidAttemptId(saved[0].attemptId as string)).toBe(true);
    expect(callOrder).toEqual([
      `update:${MessageAttemptStatus.SUBMITTING}`,
      `send:${saved[0].attemptId}`,
      `update:${MessageAttemptStatus.TRACKING}`,
    ]);
  });

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

  it('재발송 유형은 직전 시도를 체인 부모로 연결한다(rootAttemptId 상속)', async () => {
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

  it('shadow 단계 무해성 — 추적이 실패해도 발송은 상관키 없이 그대로 수행된다', async () => {
    const { service } = createService({ save: jest.fn().mockRejectedValue(new Error('db down')) });
    const send = jest.fn().mockResolvedValue({ mseq: null, recovered: false });

    await expect(service.trackSend(ctx(), send)).resolves.toEqual({ mseq: null, recovered: false });
    expect(send).toHaveBeenCalledWith(undefined);
  });

  it('추적 갱신이 실패해도 발송 결과를 그대로 돌려준다', async () => {
    const { service } = createService({
      update: jest.fn().mockResolvedValueOnce({ affected: 1 }).mockRejectedValueOnce(new Error('db down')),
    });

    await expect(service.trackSend(ctx(), async () => ({ mseq: 3, recovered: false }))).resolves.toEqual({
      mseq: 3,
      recovered: false,
    });
  });
});
