import { BadRequestException } from '@nestjs/common';
import { OrderFromService } from './order.from.service';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { systemFromPhoneNumber } from '../../const';

const makeSut = () => {
  const sut: any = Object.create(OrderFromService.prototype);
  sut.orderFromDefinitionRepository = { find: jest.fn().mockResolvedValue([]) };
  return sut;
};

describe('OrderFromService SoT — getApprovedPhoneSet / resolve', () => {
  it('getApprovedPhoneSet 은 정규화된 from 들의 Set 을 1회 조회로 반환', async () => {
    const sut = makeSut();
    sut.orderFromDefinitionRepository.find.mockResolvedValue([
      { from: '02-1234-5678', isDefault: true, id: 1 },
      { from: '010 1111 2222', isDefault: false, id: 2 },
    ]);
    const set = await sut.getApprovedPhoneSet(10);
    expect(set.has('0212345678')).toBe(true);
    expect(set.has('01011112222')).toBe(true);
    expect(sut.orderFromDefinitionRepository.find).toHaveBeenCalledTimes(1);
  });

  it('resolveApprovedDefaultPhone 은 첫 행 from, 없으면 null', async () => {
    const sut = makeSut();
    sut.orderFromDefinitionRepository.find.mockResolvedValue([{ from: '0212345678', isDefault: true, id: 5 }]);
    expect(await sut.resolveApprovedDefaultPhone(10)).toBe('0212345678');
    sut.orderFromDefinitionRepository.find.mockResolvedValue([]);
    expect(await sut.resolveApprovedDefaultPhone(10)).toBeNull();
  });

  it('resolveSendDefaultPhone 은 승인번호 없으면 systemFromPhoneNumber', async () => {
    const sut = makeSut();
    sut.orderFromDefinitionRepository.find.mockResolvedValue([]);
    expect(await sut.resolveSendDefaultPhone(10)).toBe(systemFromPhoneNumber);
  });
});

describe('OrderFromService SoT — assertApprovedPhones', () => {
  const mapping = (sendMethod: IOrderSendMethod, fromPhoneNumber: string | null) =>
    ({ sendMethod, fromPhoneNumber }) as any;

  it('MMS 미승인 번호는 차단', async () => {
    const sut = makeSut();
    sut.orderFromDefinitionRepository.find.mockResolvedValue([{ from: '0212345678', isDefault: true, id: 1 }]);
    await expect(sut.assertApprovedPhones(10, [mapping(IOrderSendMethod.MMS, '01099998888')])).rejects.toThrow(BadRequestException);
  });

  it('MMS 승인 번호는 통과 (정규화 매칭)', async () => {
    const sut = makeSut();
    sut.orderFromDefinitionRepository.find.mockResolvedValue([{ from: '02-1234-5678', isDefault: true, id: 1 }]);
    await expect(sut.assertApprovedPhones(10, [mapping(IOrderSendMethod.MMS, '0212345678')])).resolves.toBeUndefined();
  });

  it('ALIM_TALK 은 systemFromPhoneNumber 만 허용', async () => {
    const sut = makeSut();
    sut.orderFromDefinitionRepository.find.mockResolvedValue([]);
    await expect(sut.assertApprovedPhones(10, [mapping(IOrderSendMethod.ALIM_TALK, '16443614')])).resolves.toBeUndefined();
    await expect(sut.assertApprovedPhones(10, [mapping(IOrderSendMethod.ALIM_TALK, '01099998888')])).rejects.toThrow(BadRequestException);
  });

  it('ALIM_TALK 빈값은 차단', async () => {
    const sut = makeSut();
    sut.orderFromDefinitionRepository.find.mockResolvedValue([]);
    await expect(sut.assertApprovedPhones(10, [mapping(IOrderSendMethod.ALIM_TALK, null)])).rejects.toThrow(BadRequestException);
  });

  it('MMS + ALIM_TALK 혼합 배열은 둘 다 검증 통과', async () => {
    const sut = makeSut();
    sut.orderFromDefinitionRepository.find.mockResolvedValue([{ from: '0212345678', isDefault: true, id: 1 }]);
    await expect(
      sut.assertApprovedPhones(10, [
        mapping(IOrderSendMethod.MMS, '0212345678'),
        mapping(IOrderSendMethod.ALIM_TALK, systemFromPhoneNumber),
      ]),
    ).resolves.toBeUndefined();
  });

  it('상품 N개라도 find 는 1회만 (Set 재사용)', async () => {
    const sut = makeSut();
    sut.orderFromDefinitionRepository.find.mockResolvedValue([{ from: '0212345678', isDefault: true, id: 1 }]);
    await sut.assertApprovedPhones(10, [mapping(IOrderSendMethod.MMS, '0212345678'), mapping(IOrderSendMethod.MMS, '0212345678')]);
    expect(sut.orderFromDefinitionRepository.find).toHaveBeenCalledTimes(1);
  });

  it('EMAIL 등 비전화 sendMethod 는 검증 skip', async () => {
    const sut = makeSut();
    await sut.assertApprovedPhones(10, [mapping(IOrderSendMethod.EMAIL, null)]);
    expect(sut.orderFromDefinitionRepository.find).not.toHaveBeenCalled();
  });
});
