jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: any, _key: string, descriptor: PropertyDescriptor) => descriptor,
  Propagation: { REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSource: jest.fn(),
}));

// 알림톡 본문 템플릿은 엔티티 전 필드를 참조한다. 추적 배선 검증이 목적이므로 본문 생성은 고정한다.
jest.mock('../../delivery/domain/alim.talk.template', () => ({
  AlimTalkTemplate: jest.fn().mockReturnValue('알림톡 본문'),
}));

import { OrderReceiveService } from './order.receive.service';
import { MessageAttemptChannel, MessageAttemptType } from '../../delivery/interface/message.attempt.status';
import { DeliveryExclusiveOp } from '../../delivery/interface/delivery.workflow.status';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryEmailCouponStatus } from '../../delivery/interface/order.delivery.email.coupon.status';

/**
 * §10 2단계 "추적 커버리지 누락 0건" — 쿠폰 수령 경로의 실발송 추적 고정.
 *
 * 2026-08-04 운영 측정에서 "발송 시도했는데 `message_attempt` 가 없는" 건이 다수 관측됐고,
 * 원인으로 확인된 두 경로가 여기다. 둘 다 `smsSend`/`deliveryAlimTalk` 을 직접 호출해 상관키
 * (`EXT_COL2`) 없이 나갔고, 그 결과 결과 조회 배치·504 자동 재발송·실패내역 workflow 렌더가
 * 이 건들을 통째로 보지 못했다.
 *
 *  ① performChoicePostSend — 초이스 선택 후 MMS 발송
 *  ② sendToMMS            — 이메일 쿠폰 문자 수령(알림톡 1차 + MMS 폴백)
 */
describe('쿠폰 수령 경로 발송 추적', () => {
  const ATTEMPT_ID = 'ffffffffffffffffffffffffffffffff';

  const buildService = () => {
    const smsSend = { send: jest.fn().mockResolvedValue({ mseq: 1234, recovered: false }) };
    const deliveryAlimTalk = { send: jest.fn().mockResolvedValue({ report: { code: 'A000' } }) };
    // 실제 구현과 동일하게 attemptId 를 콜백에 주입해 상관키 전달까지 검증한다.
    const messageAttemptService = {
      trackSend: jest.fn((_ctx: unknown, send: (id?: string) => Promise<unknown>) => send(ATTEMPT_ID)),
      trackAlimTalk: jest.fn((_ctx: unknown, send: () => Promise<unknown>) => send()),
    };

    const service: any = Object.create(OrderReceiveService.prototype);
    service.smsSend = smsSend;
    service.deliveryAlimTalk = deliveryAlimTalk;
    service.messageAttemptService = messageAttemptService;
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    return { service, smsSend, deliveryAlimTalk, messageAttemptService };
  };

  describe('① 초이스 선택 후 MMS 발송(performChoicePostSend)', () => {
    const run = async () => {
      const ctx = buildService();
      const { service } = ctx;

      service.cryptoCipher = {
        decryptDeliveryTarget: jest.fn().mockReturnValue('01012345678'),
        encryptJson: jest.fn().mockReturnValue('enc-key'),
      };
      service.deliverySendService = { buildSmsText: jest.fn().mockReturnValue('본문') };
      service.orderFromService = { resolveSendDefaultPhone: jest.fn().mockResolvedValue('0212345678') };
      service.completeChoicePostSend = jest.fn().mockResolvedValue(undefined);

      const orderDelivery: any = {
        id: 777,
        imagePath: '/img/a.png',
        deliveryTarget: 'enc',
        expireAt: new Date('2026-12-31'),
        orderProductMapping: {
          sendContent: '내용',
          sendTailText: null,
          sendTitle: '제목',
          fromPhoneNumber: '0212345678',
          order: { type: 'NORMAL', user: { id: 1 } },
          product: { memo: null },
        },
      };

      await service.performChoicePostSend(orderDelivery, { memo: null }, 'token', {});
      return ctx;
    };

    it('trackSend 로 감싸 상관키(attemptId)를 실어 보낸다', async () => {
      const { smsSend, messageAttemptService } = await run();

      expect(messageAttemptService.trackSend).toHaveBeenCalledTimes(1);
      expect(messageAttemptService.trackSend.mock.calls[0][0]).toMatchObject({
        orderDeliveryId: 777,
        channel: MessageAttemptChannel.MMS,
        attemptType: MessageAttemptType.INITIAL,
        slotOp: DeliveryExclusiveOp.MESSAGE_SEND,
        sendReason: 'CHOICE_POST_SEND',
      });
      expect(smsSend.send).toHaveBeenCalledWith(expect.objectContaining({ attemptId: ATTEMPT_ID }));
    });

    it('추적 도입이 기존 결과 기록(SENT 종결)을 바꾸지 않는다', async () => {
      const { service } = await run();

      expect(service.completeChoicePostSend).toHaveBeenCalledWith(777, 'token', true);
    });
  });

  describe('② 이메일 쿠폰 문자 수령(sendToMMS)', () => {
    const run = async (alimTalkCode: string) => {
      const ctx = buildService();
      const { service, deliveryAlimTalk } = ctx;
      deliveryAlimTalk.send.mockResolvedValue({ report: { code: alimTalkCode } });

      const orderDelivery: any = {
        id: 888,
        barCode: '8503',
        imagePath: null,
        couponStatus: null,
        deliveryMethod: IOrderSendMethod.EMAIL,
        emailCouponStatus: null,
        expireAt: new Date('2026-12-31'),
        status: IOrderDeliveryStatus.WAIT,
        orderProductMapping: {
          sendContent: '내용',
          sendTailText: null,
          sendTitle: '제목',
          order: { type: 'NORMAL', user: { id: 1 } },
          product: { memo: null, type: 'GENERAL' },
        },
      };

      const finalUpdate = { set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), execute: jest.fn() };
      service.cryptoCipher = {
        decryptJson: jest.fn().mockReturnValue({ orderDeliveryId: 888, emailSendHistoryId: 5 }),
        encryptJson: jest.fn().mockReturnValue('enc-key'),
        encryptDeliveryTarget: jest.fn().mockReturnValue('enc-phone'),
      };
      service.orderDeliveryRepository = {
        createQueryBuilder: jest.fn(() => ({
          innerJoinAndSelect: jest.fn().mockReturnThis(),
          leftJoinAndSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(orderDelivery),
          update: jest.fn(() => finalUpdate),
        })),
        update: jest.fn(),
      };
      service.emailSendHistoryRepository = { findOne: jest.fn().mockResolvedValue({ id: 5, isCertified: true }) };
      service.orderFromService = { resolveSendDefaultPhone: jest.fn().mockResolvedValue('0212345678') };
      service.claimEmailCoupon = jest.fn().mockResolvedValue(true);

      await service.sendToMMS({ sendEncryptKey: 'k', phoneNumber: '01012345678' });
      return { ...ctx, finalUpdate };
    };

    it('알림톡 발송을 trackAlimTalk 으로 감싼다', async () => {
      const { messageAttemptService, deliveryAlimTalk } = await run('A000');

      expect(deliveryAlimTalk.send).toHaveBeenCalledTimes(1);
      expect(messageAttemptService.trackAlimTalk).toHaveBeenCalledTimes(1);
      expect(messageAttemptService.trackAlimTalk.mock.calls[0][0]).toMatchObject({
        orderDeliveryId: 888,
        attemptType: MessageAttemptType.INITIAL,
        slotOp: DeliveryExclusiveOp.MESSAGE_SEND,
        sendReason: 'EMAIL_COUPON_RECEIVE',
      });
      // 알림톡이 성공하면 MMS 폴백은 일어나지 않는다.
      expect(messageAttemptService.trackSend).not.toHaveBeenCalled();
    });

    it('알림톡 실패 시 MMS 폴백을 trackSend(CHANNEL_FALLBACK)로 감싸고 상관키를 실어 보낸다', async () => {
      const { messageAttemptService, smsSend } = await run('A999');

      expect(messageAttemptService.trackSend).toHaveBeenCalledTimes(1);
      expect(messageAttemptService.trackSend.mock.calls[0][0]).toMatchObject({
        orderDeliveryId: 888,
        channel: MessageAttemptChannel.MMS,
        attemptType: MessageAttemptType.CHANNEL_FALLBACK,
        slotOp: DeliveryExclusiveOp.MESSAGE_SEND,
        sendReason: 'EMAIL_COUPON_RECEIVE_FALLBACK',
      });
      expect(smsSend.send).toHaveBeenCalledWith(expect.objectContaining({ attemptId: ATTEMPT_ID }));
    });

    it('추적 도입이 기존 종결 기록(SEND/COMPLETE)을 바꾸지 않는다', async () => {
      const { finalUpdate } = await run('A000');

      expect(finalUpdate.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: IOrderDeliveryStatus.COMPLETE,
          emailCouponStatus: OrderDeliveryEmailCouponStatus.SEND,
        }),
      );
    });
  });
});
