import { OrderCancelNotificationService } from './order.cancel.notification.service';
import { CompanyType } from '../../common/domain/company.type';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';

const makeOrder = (over: Partial<OrderEntity> = {}): OrderEntity =>
  ({
    id: 1,
    code: 'ORD-1',
    eventName: '이벤트',
    cancelReason: '사유',
    canceledAt: new Date('2026-06-19T05:32:05.000Z'),
    snapshotPersonName: null,
    snapshotDocumentCompanyType: null,
    ...over,
  }) as unknown as OrderEntity;

const makeUser = (over: Partial<UserEntity> = {}): UserEntity =>
  ({
    id: 5,
    personName: '김담당',
    personEmail: 'rep@client.com',
    documentCompanyType: CompanyType.ENMAD,
    ...over,
  }) as unknown as UserEntity;

describe('OrderCancelNotificationService', () => {
  const makeSut = (sendImpl?: jest.Mock) => {
    const send = sendImpl ?? jest.fn().mockResolvedValue({ success: true, messageId: 'm1' });
    const mail = { send } as any;
    const sut = new OrderCancelNotificationService(mail);
    return { sut, send };
  };

  it('대표 이메일(첫 개)로 제목·본문을 발송한다', async () => {
    const { sut, send } = makeSut();
    await sut.notifyDirectOrderCancel(makeOrder(), makeUser({ personEmail: 'rep@client.com' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe('rep@client.com');
    expect(send.mock.calls[0][0].subject).toContain('ORD-1');
  });

  it('personEmail 이 CSV 여러 개면 첫 개만 to 로 쓴다', async () => {
    const { sut, send } = makeSut();
    await sut.notifyDirectOrderCancel(makeOrder(), makeUser({ personEmail: 'a@x.com, b@x.com ,c@x.com' }));
    expect(send.mock.calls[0][0].to).toBe('a@x.com');
  });

  it('personEmail 이 비면 발송하지 않는다', async () => {
    const { sut, send } = makeSut();
    await sut.notifyDirectOrderCancel(makeOrder(), makeUser({ personEmail: '' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('companyType 은 주문 스냅샷을 우선 사용한다', async () => {
    const { sut, send } = makeSut();
    await sut.notifyDirectOrderCancel(
      makeOrder({ snapshotDocumentCompanyType: CompanyType.SYSCUSS }),
      makeUser({ documentCompanyType: CompanyType.ENMAD }),
    );
    expect(send.mock.calls[0][0].companyType).toBe(CompanyType.SYSCUSS);
  });

  it('스냅샷이 없으면 user 의 documentCompanyType 을 쓴다', async () => {
    const { sut, send } = makeSut();
    await sut.notifyDirectOrderCancel(
      makeOrder({ snapshotDocumentCompanyType: null }),
      makeUser({ documentCompanyType: CompanyType.SYSCUSS }),
    );
    expect(send.mock.calls[0][0].companyType).toBe(CompanyType.SYSCUSS);
  });

  it('send 가 실패(success:false)해도 예외를 던지지 않는다', async () => {
    const send = jest.fn().mockResolvedValue({ success: false, error: 'smtp down' });
    const { sut } = makeSut(send);
    await expect(sut.notifyDirectOrderCancel(makeOrder(), makeUser())).resolves.toBeUndefined();
  });
});
