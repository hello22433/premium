// 실제 DB 연결이 없는 단위 테스트이므로 @Transactional 을 no-op 으로 mock 한다. (관례: exec-resend.spec)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_t: unknown, _k: unknown, d: unknown) => d,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { ConflictException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';
import { CS_HISTORY_TYPE } from '../api/customer.service.req.dto';
import { IOrderSendMethod } from '../../order/interface/order.send.method';

/**
 * CS "수신정보 변경요청"(RECEIVER_CHANGE) — 수신자를 바꾸고 **곧바로 재발송**하는 경로.
 *
 * execHistory 에는 트랜잭션이 없다(컨트롤러도 없다). 그래서 수신자 update 는 즉시 커밋되는데,
 * 종전에는 이력 저장이 reSend **뒤**(공통 말미)에 있었다.
 *
 * reSend 는 폐기·재발행·배치가 그 행을 점유 중이면 claim CAS 실패로 409 를 던진다.
 * 그때 **수신자(PII)만 바뀐 채 order_history 에 아무 흔적도 남지 않았다** — 되돌리는 코드도 없어
 * 누가 언제 어떤 번호로 바꿨는지 추적이 불가능했다.
 *
 * 수신자 변경은 update 가 커밋된 시점에 이미 확정된 사실이다. 후속 발송의 성패와 무관하게
 * 기록되어야 한다. (같은 판단 선례: 65298e0 "이력을 발송 전으로")
 */
describe('CustomerServiceService.execHistory — RECEIVER_CHANGE 이력/발송 순서', () => {
  const NEW_PHONE = '01098765432';
  const ENCRYPTED = 'ENC(01098765432)';

  function makeService() {
    const sut = Object.create(CustomerServiceService.prototype) as CustomerServiceService;
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (sut as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };

    const odUpdate = jest.fn(async () => ({ affected: 1 }));
    const historySave = jest.fn(async (h: any) => h);
    const reSend = jest.fn(async () => undefined);
    const calls: string[] = [];

    (sut as any).orderDeliveryRepository = { update: jest.fn(async (...a: any[]) => (calls.push('update'), odUpdate(...(a as [])))) };
    (sut as any).orderHistoryRepository = {
      create: jest.fn((o: any) => o),
      save: jest.fn(async (h: any) => (calls.push('history'), historySave(h))),
    };
    (sut as any).cryptoCipher = { encryptDeliveryTarget: jest.fn(() => ENCRYPTED) };
    (sut as any).reSend = jest.fn(async (...a: any[]) => (calls.push('reSend'), reSend(...(a as []))));
    (sut as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    return { sut, calls, historySave, reSend };
  }

  /** SMS 발송건(기본 분기) — 전화번호만 허용. */
  const makeMap = () => ({
    type: CS_HISTORY_TYPE.RECEIVER_CHANGE,
    orderDeliveryId: 77,
    orderDelivery: {
      id: 77,
      deliveryMethod: IOrderSendMethod.MMS,
      barCode: 'PIN-1',
      emailReceiverPhone: null,
    },
    afterChange: NEW_PHONE,
    beforeChange: 'ENC(01011112222)',
    content: '수신번호 변경',
    sendMethod: IOrderSendMethod.MMS,
    user: { id: 3 },
    userId: 3,
  });

  it('이력을 재발송 **전에** 저장한다 (순서 계약)', async () => {
    const { sut, calls } = makeService();

    await (sut as any).execHistory(makeMap());

    // update(수신자) → history(이력) → reSend(발송)
    expect(calls).toEqual(['update', 'history', 'reSend']);
  });

  it('★ 재발송이 실패해도 수신자 변경 이력은 남는다 (핵심 회귀)', async () => {
    const { sut, historySave } = makeService();
    (sut as any).reSend = jest.fn(async () => {
      throw new ConflictException('재발송 처리 중이거나 상태가 변경되었습니다.');
    });

    // 예외는 그대로 전파되어야 한다 — 운영자는 발송이 안 됐음을 알아야 한다.
    await expect((sut as any).execHistory(makeMap())).rejects.toBeInstanceOf(ConflictException);

    // 그러나 PII 변경 사실은 기록돼 있어야 한다. 종전에는 여기가 0건이었다.
    expect(historySave).toHaveBeenCalledTimes(1);
    expect(historySave.mock.calls[0][0]).toMatchObject({
      orderDeliveryId: 77,
      type: CS_HISTORY_TYPE.RECEIVER_CHANGE,
      afterChange: ENCRYPTED,
      beforeChange: 'ENC(01011112222)',
      userId: 3,
    });
  });

  it('성공 경로에서 이력이 중복 저장되지 않는다 (조기 return)', async () => {
    const { sut, historySave } = makeService();

    await (sut as any).execHistory(makeMap());

    // 공통 말미가 한 번 더 저장하면 같은 변경이 2건으로 보인다.
    expect(historySave).toHaveBeenCalledTimes(1);
  });

  it('수신자 update 는 암호화된 새 번호로 나간다', async () => {
    const { sut } = makeService();
    const map = makeMap();

    await (sut as any).execHistory(map);

    expect((sut as any).orderDeliveryRepository.update).toHaveBeenCalledWith(77, {
      deliveryTarget: ENCRYPTED,
    });
  });
});
