// execResend 는 @Transactional() 이라 트랜잭션 컨텍스트가 필요하다. 데코레이터만 무력화한다.
// (requireActual 스프레드: import 그래프의 다른 서비스가 Propagation 등을 로드 시점에 쓰므로)
jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { BadRequestException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

/**
 * CS 재전송(execResend) — 발송취소(부분취소, 197-16) 차단 회귀.
 *
 * 발송취소 건은 status=CANCEL / couponStatus=NOT_USED / barCode=NULL 로 남는다. csResendAs* 의
 * 가드는 barCode 기반이라(csResendAsEmail=barCode&&emailReceiverPhone, 미선택 CHOICE 우회) 이를
 * 놓친다. status 가드가 없으면 취소·환불된 쿠폰이 재발송으로 되살아나 수령자가 교환할 수 있다(돈 누수).
 *
 * execResend 는 private 이라 Object.create 로 생성자 우회 후 직접 호출한다(discard-concurrency.spec 관례).
 */
describe('CustomerServiceService.execResend — 발송취소 차단', () => {
  const buildLocked = (status: IOrderDeliveryStatus) => ({ id: 5001, status, reportState: null }) as any;

  const makeSut = (locked: any) => {
    const sut: any = Object.create(CustomerServiceService.prototype);
    const qb: any = {};
    for (const m of ['createQueryBuilder', 'setLock', 'where']) qb[m] = jest.fn(() => qb);
    qb.getOne = jest.fn().mockResolvedValue(locked);
    sut.orderDeliveryRepository = { createQueryBuilder: jest.fn(() => qb) };
    sut.orderHistoryRepository = { count: jest.fn().mockResolvedValue(0), create: jest.fn(), save: jest.fn() };
    sut.deliveryBatchService = {
      csResendAsEmail: jest.fn(),
      csResendAsMms: jest.fn(),
      csResendAsSms: jest.fn(),
      csResendAsAlimTalk: jest.fn(),
    };
    return sut;
  };

  const call = (sut: any, extraType: string) =>
    sut.execResend({ orderDeliveryId: 5001, extraType, userId: 9, type: 'RESEND', content: '재전송' });

  it.each(['email', 'forced_mms', 'sms', 'alimtalk'])(
    'status=CANCEL 이면 %s 재전송을 거부하고 실제 발송을 호출하지 않는다',
    async (extraType) => {
      const sut = makeSut(buildLocked(IOrderDeliveryStatus.CANCEL));

      await expect(call(sut, extraType)).rejects.toBeInstanceOf(BadRequestException);

      expect(sut.deliveryBatchService.csResendAsEmail).not.toHaveBeenCalled();
      expect(sut.deliveryBatchService.csResendAsMms).not.toHaveBeenCalled();
      expect(sut.deliveryBatchService.csResendAsSms).not.toHaveBeenCalled();
      expect(sut.deliveryBatchService.csResendAsAlimTalk).not.toHaveBeenCalled();
      // 이력도 남기지 않는다(발송 자체가 없었으므로).
      expect(sut.orderHistoryRepository.save).not.toHaveBeenCalled();
    },
  );

  it('취소가 아니면(FAIL) 종전대로 재전송 경로로 진입한다', async () => {
    const sut = makeSut(buildLocked(IOrderDeliveryStatus.FAIL));

    await call(sut, 'email');

    expect(sut.deliveryBatchService.csResendAsEmail).toHaveBeenCalledWith(5001);
  });
});
