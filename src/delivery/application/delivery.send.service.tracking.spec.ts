// 템플릿 렌더링은 이 테스트의 관심사가 아니다(엔티티 전체를 채우지 않기 위해 고정 문자열로 대체).
jest.mock('../domain/alim.talk.template', () => ({ AlimTalkTemplate: () => '알림톡 본문' }));

import { DeliverySendService } from './delivery.send.service';
import { DeliveryExclusiveOp } from '../interface/delivery.workflow.status';
import { MessageAttemptChannel, MessageAttemptType } from '../interface/message.attempt.status';

/**
 * 발송 경로가 추적·컷오버 게이트를 우회하지 않는지 고정한다.
 * plans/프리미엄_발송실패_재발송_구상.md §3 나(모든 쿠폰 발송 추적) / §9(전환 마크 기반 진입 거부).
 *
 * 생성자 의존성이 많아 Object.create 로 프로토타입만 끌어오고 필요한 협력자만 주입한다
 * (delivery.batch.claim-mutation-lease.spec.ts 와 동일 패턴).
 */
describe('DeliverySendService — 알림톡 발송 추적 배선', () => {
  const buildSut = () => {
    const sut = Object.create(DeliverySendService.prototype);

    const trackAlimTalk = jest.fn().mockImplementation((_ctx: unknown, send: () => Promise<unknown>) => send());
    const postAlimtalk = jest.fn().mockResolvedValue({ msgKey: 'MK-1', responseData: { code: 'A000' } });
    const alimTalkSend = jest.fn().mockResolvedValue({ responseData: {}, report: { code: 'A000' } });

    (sut as any).messageAttemptService = { trackAlimTalk, trackSend: jest.fn() };
    (sut as any).deliveryAlimTalk = { postAlimtalk, send: alimTalkSend };
    (sut as any).markSendSuccess = jest.fn();
    (sut as any).markSendFail = jest.fn();
    (sut as any).markAlimtalkPending = jest.fn();
    (sut as any).handleAlimTalkFail = jest.fn();
    (sut as any).logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };

    return { sut, trackAlimTalk, postAlimtalk, alimTalkSend };
  };

  const orderDelivery = () =>
    ({
      id: 991,
      orderProductMapping: { product: { name: '상품' }, order: {} },
    }) as any;

  it('비동기 알림톡(발송 배치)도 trackAlimTalk 을 통해서만 외부 호출한다', async () => {
    const { sut, trackAlimTalk, postAlimtalk } = buildSut();
    const deliveryHistory: any = {};

    await (sut as any).sendAlimTalkAsync(
      orderDelivery(),
      '01012345678',
      'enc',
      '제목',
      '본문',
      null,
      null,
      [],
      deliveryHistory,
    );

    expect(trackAlimTalk).toHaveBeenCalledTimes(1);
    expect(postAlimtalk).toHaveBeenCalledTimes(1);

    // 추적 컨텍스트는 채널·op 가 명시돼야 전환 건에서 올바른 슬롯을 점유한다.
    const [ctx, , accepted] = trackAlimTalk.mock.calls[0];
    expect(ctx).toMatchObject({
      orderDeliveryId: 991,
      slotOp: DeliveryExclusiveOp.MESSAGE_SEND,
      attemptType: MessageAttemptType.INITIAL,
    });
    // POST 수락(msgKey 확보)만 접수 성공으로 본다(최종 도달은 reportSweep 확정).
    expect(accepted({ msgKey: 'MK-1' })).toBe(true);
    expect(accepted({ msgKey: undefined })).toBe(false);
  });

  it('동기 알림톡도 같은 게이트를 거친다(채널=ALIM_TALK 는 서비스가 강제)', async () => {
    const { sut, trackAlimTalk, alimTalkSend } = buildSut();
    const deliveryHistory: any = {};

    await (sut as any).sendAlimTalk(
      orderDelivery(),
      '01012345678',
      'enc',
      '제목',
      '본문',
      null,
      null,
      [],
      deliveryHistory,
    );

    expect(trackAlimTalk).toHaveBeenCalledTimes(1);
    expect(alimTalkSend).toHaveBeenCalledTimes(1);
    expect(trackAlimTalk.mock.calls[0][0]).toMatchObject({ slotOp: DeliveryExclusiveOp.MESSAGE_SEND });
    // 채널은 ctx 가 아니라 trackAlimTalk 내부에서 ALIM_TALK 로 고정된다.
    expect(trackAlimTalk.mock.calls[0][0].channel).toBeUndefined();
    expect(MessageAttemptChannel.ALIM_TALK).toBe('ALIM_TALK');
  });

  /**
   * 폴백 경계와 실패 사유 기록 계약.
   *
   * - 폴백은 "알림톡이 나가지 못했다"가 확정된 경우로만 한정한다. 도달 뒤의 후속 처리 실패까지
   *   폴백을 태우면 같은 쿠폰이 MMS 로 중복 발송된다.
   * - 실패 사유(reportCode 63018/63019/63020 등)는 delivery_send_history.context 에 남아야 한다.
   *   Error 를 JSON.stringify 하면 '{}' 라 사유가 통째로 사라졌던 회귀를 고정한다.
   */
  describe('알림톡 실패 판정과 폴백 경계', () => {
    const args = (deliveryHistory: any) =>
      [orderDelivery(), '01012345678', 'enc', '제목', '본문', null, null, [], deliveryHistory] as const;

    it('알림톡 실패 응답이면 폴백하고 실패 사유(reportCode)를 context 에 남긴다', async () => {
      const { sut, alimTalkSend } = buildSut();
      alimTalkSend.mockResolvedValue({
        responseData: { code: 'A000' },
        report: { code: '7000', data: { report: [{ reportCode: '63019', reportText: '수신 차단' }] } },
      });
      const deliveryHistory: any = {};

      await (sut as any).sendAlimTalk(...args(deliveryHistory));

      expect((sut as any).handleAlimTalkFail).toHaveBeenCalledTimes(1);
      expect(deliveryHistory.context).toContain('63019');
      // 응답 원문도 지우지 않는다(사유만 덧붙인다).
      expect(deliveryHistory.context).toContain('A000');
      expect(deliveryHistory.isSuccess).toBe(false);
    });

    it('알림톡 도달 확정 후의 후속 처리 실패는 폴백하지 않는다(MMS 중복 발송 차단)', async () => {
      const { sut } = buildSut();
      (sut as any).markSendSuccess = jest.fn(() => {
        throw new Error('후속 처리 실패');
      });
      const deliveryHistory: any = {};

      await (sut as any).sendAlimTalk(...args(deliveryHistory));

      expect((sut as any).handleAlimTalkFail).not.toHaveBeenCalled();
      expect((sut as any).logger.error).toHaveBeenCalledTimes(1);
    });

    it('비동기 경로도 POST 수락 뒤의 실패는 폴백하지 않는다', async () => {
      const { sut } = buildSut();
      (sut as any).markAlimtalkPending = jest.fn(() => {
        throw new Error('PENDING 마킹 실패');
      });
      const deliveryHistory: any = {};

      await (sut as any).sendAlimTalkAsync(...args(deliveryHistory));

      expect((sut as any).handleAlimTalkFail).not.toHaveBeenCalled();
      expect((sut as any).logger.error).toHaveBeenCalledTimes(1);
    });

    /**
     * tracker 는 외부 발송 뒤의 종결 기록·게이트 해제 실패를 자체적으로 삼키고 결과를 돌려준다
     * (그 계약은 message-attempt.service.spec 이 잠근다).
     * 여기서는 그 결과가 호출자에서 정상 성공 경로로 흘러 폴백이 돌지 않는지를 고정한다.
     */
    it('tracker 내부 후처리가 실패해도 결과가 오면 폴백하지 않는다', async () => {
      const { sut, trackAlimTalk, alimTalkSend } = buildSut();
      // 종결 기록 실패를 삼킨 tracker: 외부 호출은 수행하고 결과는 그대로 반환한다.
      trackAlimTalk.mockImplementation(async (_ctx: unknown, send: () => Promise<unknown>) => {
        const result = await send();
        // resolveAlimTalk / closeGate 실패에 해당 — 던지지 않는다.
        return result;
      });
      const deliveryHistory: any = {};

      await (sut as any).sendAlimTalk(...args(deliveryHistory));

      expect(alimTalkSend).toHaveBeenCalledTimes(1);
      expect((sut as any).handleAlimTalkFail).not.toHaveBeenCalled();
      expect((sut as any).markSendSuccess).toHaveBeenCalledTimes(1);
    });

    it('도달 확정 후 이력 직렬화가 실패해도 폴백하지 않는다', async () => {
      const { sut, alimTalkSend } = buildSut();
      const circular: any = { code: 'A000' };
      circular.self = circular; // JSON.stringify 시 TypeError
      alimTalkSend.mockResolvedValue({ responseData: circular, report: { code: 'A000' } });
      const deliveryHistory: any = {};

      await (sut as any).sendAlimTalk(...args(deliveryHistory));

      expect((sut as any).handleAlimTalkFail).not.toHaveBeenCalled();
      expect((sut as any).logger.error).toHaveBeenCalledTimes(1);
    });

    it('알림톡 호출 전 예외(템플릿·추적 준비)는 폴백 대상이다', async () => {
      const { sut, trackAlimTalk } = buildSut();
      trackAlimTalk.mockRejectedValue(new Error("Cannot read properties of undefined (reading 'company')"));
      const deliveryHistory: any = {};

      await (sut as any).sendAlimTalk(...args(deliveryHistory));

      expect((sut as any).handleAlimTalkFail).toHaveBeenCalledTimes(1);
      expect(deliveryHistory.context).toContain('company');
    });
  });
});
