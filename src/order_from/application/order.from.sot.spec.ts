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

describe('OrderFromService — reconcile 연결 (admin/setDefault)', () => {
  const makeTxSut = (item: any) => {
    const sut: any = Object.create(OrderFromService.prototype);
    const repo = {
      findOne: jest.fn().mockResolvedValue(item),
      update: jest.fn().mockResolvedValue(undefined),
      softDelete: jest.fn().mockResolvedValue(undefined),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(repo) };
    sut.dataSource = { transaction: jest.fn(async (cb: any) => cb(manager)) };
    sut.reconcileDefaultAndMirror = jest.fn().mockResolvedValue(undefined);
    sut.assertCanActForUser = jest.fn();
    return { sut, repo, manager };
  };

  it('adminApprove(PHONE) 후 reconcile 호출', async () => {
    const { sut, repo, manager } = makeTxSut({ id: 7, type: 'PHONE', userId: 10, requestStatus: 'PENDING' });
    await sut.adminApprove(7);
    expect(repo.update).toHaveBeenCalledWith(7, { requestStatus: 'APPROVED' });
    expect(sut.reconcileDefaultAndMirror).toHaveBeenCalledWith(manager, 10);
  });

  it('adminReject(PHONE) 후 reconcile 호출', async () => {
    const { sut, manager } = makeTxSut({ id: 7, type: 'PHONE', userId: 10, requestStatus: 'PENDING' });
    await sut.adminReject(7, '사유');
    expect(sut.reconcileDefaultAndMirror).toHaveBeenCalledWith(manager, 10);
  });

  it('adminDelete(PHONE) 후 reconcile 호출', async () => {
    const { sut, repo, manager } = makeTxSut({ id: 7, type: 'PHONE', userId: 10 });
    await sut.adminDelete(7);
    expect(repo.softDelete).toHaveBeenCalledWith(7);
    expect(sut.reconcileDefaultAndMirror).toHaveBeenCalledWith(manager, 10);
  });

  it('adminApprove(EMAIL) 는 reconcile 호출 안 함', async () => {
    const { sut } = makeTxSut({ id: 7, type: 'EMAIL', userId: null, requestStatus: 'PENDING' });
    await sut.adminApprove(7);
    expect(sut.reconcileDefaultAndMirror).not.toHaveBeenCalled();
  });

  it('setDefault 는 항목 검증 후 reconcile(preferId) 호출', async () => {
    const { sut, manager } = makeTxSut({ id: 5, type: 'PHONE', userId: 10, requestStatus: 'APPROVED' });
    await sut.setDefault({ id: 99, authority: 'OPERATION_ADMIN' }, { id: 5, userId: 10 });
    expect(sut.reconcileDefaultAndMirror).toHaveBeenCalledWith(manager, 10, 5);
  });
});

describe('OrderFromService — getPhoneList 본인번호만 (회사 fallback 제거)', () => {
  const makeListSut = (ownList: any[] = []) => {
    const sut: any = Object.create(OrderFromService.prototype);
    sut.orderFromDefinitionRepository = { find: jest.fn().mockResolvedValue(ownList) };
    sut.userRepository = { find: jest.fn(), findOne: jest.fn() };
    sut.assertCanActForUser = jest.fn();
    return sut;
  };

  it('본인 승인번호 없으면 빈 배열, 회사 조회 안 함', async () => {
    const sut = makeListSut([]);
    const res = await sut.getPhoneList({ id: 10, authority: 'OPERATION_ADMIN' }, { userId: 10 });
    expect(res.list).toEqual([]);
    expect(sut.userRepository.find).not.toHaveBeenCalled();
  });

  it('본인 승인번호 있으면 그대로 반환', async () => {
    const sut = makeListSut([{ id: 1, from: '0212345678', isDefault: true, requestStatus: 'APPROVED', telecomCertType: null, telecomCertFile: null, rejectReason: null, createdAt: new Date() }]);
    const res = await sut.getPhoneList({ id: 10, authority: 'OPERATION_ADMIN' }, { userId: 10 });
    expect(res.list).toHaveLength(1);
    expect(sut.userRepository.find).not.toHaveBeenCalled();
  });
});

describe('OrderFromService — createPhone 정규화/블랙리스트', () => {
  const makeCreateSut = (existing: any[] = []) => {
    const sut: any = Object.create(OrderFromService.prototype);
    const repo = {
      find: jest.fn().mockResolvedValue(existing),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 100 }] }),
    };
    sut.orderFromDefinitionRepository = repo;
    sut.assertCanActForUser = jest.fn();
    sut.reconcileDefaultAndMirror = jest.fn().mockResolvedValue(undefined);
    const manager = { getRepository: jest.fn().mockReturnValue(repo) };
    sut.dataSource = { transaction: jest.fn(async (cb: any) => cb(manager)) };
    return { sut, repo, manager };
  };

  it('시스템번호(하이픈 포함)는 블랙리스트 차단', async () => {
    const { sut, repo } = makeCreateSut();
    await expect(sut.createPhone({ id: 10, authority: 'CORPORATE_ADMIN' }, { from: '1644-3614' })).rejects.toThrow(BadRequestException);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('정규화 후 중복이면 차단', async () => {
    const { sut, repo } = makeCreateSut([{ from: '02-1234-5678' }]);
    await expect(sut.createPhone({ id: 10, authority: 'CORPORATE_ADMIN' }, { from: '0212345678' })).rejects.toThrow(BadRequestException);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('CORPORATE_ADMIN 정상 등록은 PENDING, reconcile 안 함', async () => {
    const { sut, repo } = makeCreateSut();
    await sut.createPhone({ id: 10, authority: 'CORPORATE_ADMIN' }, { from: '010-9999-8888' });
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ from: '01099998888', requestStatus: 'PENDING' }));
    expect(sut.reconcileDefaultAndMirror).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN 등록은 APPROVED + reconcile 호출', async () => {
    const { sut, manager } = makeCreateSut();
    await sut.createPhone({ id: 1, authority: 'SUPER_ADMIN' }, { from: '010-9999-8888', userId: 10 });
    expect(sut.reconcileDefaultAndMirror).toHaveBeenCalledWith(manager, 10, 100);
  });

  it('빈 값 입력은 400', async () => {
    const { sut } = makeCreateSut();
    await expect(sut.createPhone({ id: 10, authority: 'CORPORATE_ADMIN' }, { from: '---' })).rejects.toThrow(BadRequestException);
  });
});
