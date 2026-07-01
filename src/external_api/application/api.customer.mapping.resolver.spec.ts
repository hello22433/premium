import { ApiCustomerMappingResolver } from './api.customer.mapping.resolver';
import { ApiCustomerMappingEntity } from '../../entity/api.customer.mapping.entity';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';
import { IUserStatus } from '../../user/interface/user.status';
import { ExternalApiException } from '../api/external.api.exception.filter';

type RepoMock<T> = { findOne: jest.Mock };

describe('ApiCustomerMappingResolver (PR2 Phase 2)', () => {
  let mappingRepo: RepoMock<ApiCustomerMappingEntity>;
  let userRepo: RepoMock<UserEntity>;
  let orderRepo: RepoMock<OrderEntity>;
  let resolver: ApiCustomerMappingResolver;

  const activeUser = (id: number): UserEntity =>
    ({ id, status: IUserStatus.USED, company: { id: 9 } }) as unknown as UserEntity;

  beforeEach(() => {
    mappingRepo = { findOne: jest.fn() };
    userRepo = { findOne: jest.fn() };
    orderRepo = { findOne: jest.fn() };
    resolver = new ApiCustomerMappingResolver(mappingRepo as any, userRepo as any, orderRepo as any);
  });

  describe('resolveBillingTarget', () => {
    it('단순모드: externalCustomerId 미지정 → default billing user, clientUserId=null', async () => {
      userRepo.findOne.mockResolvedValue(activeUser(42));
      const res = await resolver.resolveBillingTarget('1', null, 42, false);
      expect(res.clientUserId).toBeNull();
      expect(res.externalCustomerId).toBeNull();
      expect(res.billingUser.id).toBe(42);
      // 단순모드는 매핑 조회를 하지 않는다
      expect(mappingRepo.findOne).not.toHaveBeenCalled();
      expect(userRepo.findOne).toHaveBeenCalledWith({ where: { id: 42 }, relations: ['company'] });
    });

    it('단순모드: 빈 문자열/공백도 단순모드로 처리', async () => {
      userRepo.findOne.mockResolvedValue(activeUser(42));
      const res = await resolver.resolveBillingTarget('1', '   ', 42, false);
      expect(res.clientUserId).toBeNull();
      expect(mappingRepo.findOne).not.toHaveBeenCalled();
    });

    it('매핑모드: 등록된 externalCustomerId → 매핑 billing user, clientUserId=billingUserId', async () => {
      mappingRepo.findOne.mockResolvedValue({ apiAppId: '1', externalCustomerId: 'c-1', billingUserId: 77 });
      userRepo.findOne.mockResolvedValue(activeUser(77));
      const res = await resolver.resolveBillingTarget('1', 'c-1', 42, false);
      expect(res.clientUserId).toBe(77);
      expect(res.externalCustomerId).toBe('c-1');
      expect(res.billingUser.id).toBe(77);
      expect(mappingRepo.findOne).toHaveBeenCalledWith({
        where: { apiAppId: '1', externalCustomerId: 'c-1' },
      });
    });

    it('매핑모드: externalCustomerId 양끝 공백 정규화 후 조회', async () => {
      mappingRepo.findOne.mockResolvedValue({ apiAppId: '1', externalCustomerId: 'c-1', billingUserId: 77 });
      userRepo.findOne.mockResolvedValue(activeUser(77));
      await resolver.resolveBillingTarget('1', '  c-1  ', 42, false);
      expect(mappingRepo.findOne).toHaveBeenCalledWith({
        where: { apiAppId: '1', externalCustomerId: 'c-1' },
      });
    });

    it('미등록 externalCustomerId → 4003 (default fallback 금지, fail-closed)', async () => {
      mappingRepo.findOne.mockResolvedValue(null);
      await expect(resolver.resolveBillingTarget('1', 'unknown', 42, false)).rejects.toMatchObject({
        code: '4003',
      });
      // default billing 으로 폴백하지 않는다
      expect(userRepo.findOne).not.toHaveBeenCalled();
    });

    it('billing user 미존재 → 4003', async () => {
      mappingRepo.findOne.mockResolvedValue({ apiAppId: '1', externalCustomerId: 'c-1', billingUserId: 77 });
      userRepo.findOne.mockResolvedValue(null);
      await expect(resolver.resolveBillingTarget('1', 'c-1', 42, false)).rejects.toMatchObject({ code: '4003' });
    });

    it('billing user 휴면(NOT_USED) → 1001 fail-closed', async () => {
      mappingRepo.findOne.mockResolvedValue({ apiAppId: '1', externalCustomerId: 'c-1', billingUserId: 77 });
      userRepo.findOne.mockResolvedValue({ id: 77, status: IUserStatus.NOT_USED } as unknown as UserEntity);
      await expect(resolver.resolveBillingTarget('1', 'c-1', 42, false)).rejects.toBeInstanceOf(ExternalApiException);
      await expect(resolver.resolveBillingTarget('1', 'c-1', 42, false)).rejects.toMatchObject({ code: '1001' });
    });

    it('billing user 탈퇴(LEAVE) → 1001 fail-closed', async () => {
      userRepo.findOne.mockResolvedValue({ id: 42, status: IUserStatus.LEAVE } as unknown as UserEntity);
      await expect(resolver.resolveBillingTarget('1', null, 42, false)).rejects.toMatchObject({ code: '1001' });
    });

    it('매핑 필수 모드: externalCustomerId 미지정 → 2001 (default fallback 차단)', async () => {
      await expect(resolver.resolveBillingTarget('1', null, 42, true)).rejects.toMatchObject({ code: '2001' });
      // default billing 으로 폴백하지 않는다
      expect(userRepo.findOne).not.toHaveBeenCalled();
      expect(mappingRepo.findOne).not.toHaveBeenCalled();
    });

    it('매핑 필수 모드: 공백만 있는 externalCustomerId → 2001', async () => {
      await expect(resolver.resolveBillingTarget('1', '   ', 42, true)).rejects.toMatchObject({ code: '2001' });
      expect(userRepo.findOne).not.toHaveBeenCalled();
    });

    it('매핑 필수 모드: 유효 externalCustomerId → 정상 매핑 청구(플래그 무영향)', async () => {
      mappingRepo.findOne.mockResolvedValue({ apiAppId: '1', externalCustomerId: 'c-1', billingUserId: 77 });
      userRepo.findOne.mockResolvedValue(activeUser(77));
      const res = await resolver.resolveBillingTarget('1', 'c-1', 42, true);
      expect(res.clientUserId).toBe(77);
      expect(res.billingUser.id).toBe(77);
    });
  });

  describe('findExistingOrderByExternalOrderId', () => {
    it('externalOrderId 미지정 → null (조회 안함)', async () => {
      expect(await resolver.findExistingOrderByExternalOrderId('1', null)).toBeNull();
      expect(await resolver.findExistingOrderByExternalOrderId('1', '  ')).toBeNull();
      expect(orderRepo.findOne).not.toHaveBeenCalled();
    });

    it('동일 (apiAppId, externalOrderId) 기존 주문 반환 (멱등 보조)', async () => {
      const existing = { id: 555 } as OrderEntity;
      orderRepo.findOne.mockResolvedValue(existing);
      const res = await resolver.findExistingOrderByExternalOrderId('1', ' WA-1 ');
      expect(res).toBe(existing);
      expect(orderRepo.findOne).toHaveBeenCalledWith({ where: { apiAppId: '1', externalOrderId: 'WA-1' } });
    });
  });
});
