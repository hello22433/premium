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
    (sut as any).handleAlimTalkFail = jest.fn();

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
});
