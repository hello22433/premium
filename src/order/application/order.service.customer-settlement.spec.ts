import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IOrderSection } from '../interface/order.section';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

/**
 * getList() — customerSettlement 필드 (발송관리 고객사 호버 툴팁)
 *
 * 검증 대상 (프론트 수용 조건):
 * - wallet_account 미존재 → 필드 완전 생략
 * - settleCondition 은 항상 wallet_account.settle_condition (non-null)
 * - remainServiceAmount = creditLimit + depositBalance − creditUsedAmount − creditExcessAmount, 0-clamp
 * - 권한 화이트리스트: SUPER_ADMIN / OPERATION_ADMIN 만 포함 (CORPORATE_ADMIN 등 생략)
 * - includeSettlement=false/미전달 시 생략
 * - distinct settlement_code 1회 배치 조회 (행별 재계산 없음)
 */

const query = (over: Record<string, unknown> = {}) =>
  ({
    type: IOrderType.GENERAL,
    section: IOrderSection.SHIPPING,
    page: 1,
    take: 20,
    searchType: 'ALL',
    searchKeyword: '',
    sendingType: null,
    dateType: null,
    startAt: undefined,
    endAt: undefined,
    status: undefined,
    includeSettlement: true,
    ...over,
  }) as any;

const admin = (authority: IUserAuthority) => ({ id: 1, email: 'a@test.com', authority }) as any;

const makeOrder = (id: number, settlementCode: string | null, clientUser?: { id: number; settlementCode: string }) => ({
  id,
  registerAt: new Date('2026-07-01T00:00:00'),
  status: IOrderStatus.DELIVERY_COMPLETE,
  eventName: '테스트',
  sendAmount: 1000,
  settleAmount: 1000,
  clientUserId: clientUser?.id ?? null,
  clientUser: clientUser ?? null,
  operationUser: null,
  operationUserId: null,
  snapshotPersonName: '홍길동',
  snapshotBusinessName: `고객사${id}`,
  snapshotPersonPhone: null,
  snapshotEmail: null,
  snapshotBusinessNumber: '',
  snapshotBusinessAddress: null,
  snapshotIndustryType: null,
  snapshotIndustryItem: null,
  snapshotSettleCondition: 'MONTHLY',
  snapshotDocumentCompanyType: 'ENMAD',
  user: settlementCode === null ? { id: 100 + id, settlementCode: '' } : { id: 100 + id, settlementCode },
  orderProductMappings: [],
});

const makeWallet = (
  ownerId: string,
  fields: Partial<{
    creditLimit: number;
    depositBalance: number;
    creditUsedAmount: number;
    creditExcessAmount: number;
    settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT';
  }> = {},
) => ({
  id: ownerId,
  ownerType: 'SETTLEMENT_CODE',
  ownerId,
  creditLimit: 0,
  depositBalance: 0,
  creditUsedAmount: 0,
  creditExcessAmount: 0,
  settleCondition: 'PRE_PAYMENT',
  ...fields,
});

const setupService = (orders: any[], wallets: any[]) => {
  const qb: any = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    withDeleted: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([orders, orders.length]),
  };

  const walletFind = jest.fn().mockResolvedValue(wallets);

  const service = Object.create(OrderService.prototype) as any;
  service.orderRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  service.userRepository = {
    findOne: jest.fn().mockResolvedValue({ id: 1, companyId: null, departmentId: null }),
  };
  service.userViewScopeRepository = {
    findOne: jest.fn().mockResolvedValue({ scopeType: ViewScopeType.ALL, getDeptIdList: () => [] }),
  };
  service.walletAccountRepository = { find: walletFind };
  service['applyDirectSendingFilter'] = jest.fn();
  service['applyOrderSearchCondition'] = jest.fn().mockReturnValue(qb);
  service['applyOrderDateCondition'] = jest.fn().mockReturnValue(qb);
  service['applyViewScopeFilter'] = jest.fn().mockReturnValue(qb);

  return { service, walletFind };
};

describe('OrderService getList — customerSettlement', () => {
  it('정상: settleCondition + remainServiceAmount(정수) 포함', async () => {
    const wallet = makeWallet('company-1', {
      creditLimit: 10_000_000,
      depositBalance: 2_345_678,
      creditUsedAmount: 0,
      creditExcessAmount: 0,
      settleCondition: 'PRE_PAYMENT',
    });
    const { service } = setupService([makeOrder(1, 'company-1')], [wallet]);

    const result = await service.getList(admin(IUserAuthority.SUPER_ADMIN), query());

    expect(result.list[0].customerSettlement).toEqual({
      settleCondition: 'PRE_PAYMENT',
      remainServiceAmount: 12_345_678,
    });
  });

  it('wallet_account 미존재 → customerSettlement 필드 완전 생략', async () => {
    const { service } = setupService([makeOrder(1, 'company-nowallet')], []);

    const result = await service.getList(admin(IUserAuthority.OPERATION_ADMIN), query());

    expect('customerSettlement' in result.list[0]).toBe(false);
  });

  it('settlement_code 없는 고객사(빈 문자열) → 조회 대상 제외 + 필드 생략', async () => {
    const { service, walletFind } = setupService([makeOrder(1, null)], []);

    const result = await service.getList(admin(IUserAuthority.SUPER_ADMIN), query());

    expect(result.list[0].customerSettlement).toBeUndefined();
    // distinct code 가 0개 → wallet 조회 자체를 하지 않는다.
    expect(walletFind).not.toHaveBeenCalled();
  });

  it('remainServiceAmount 음수 계산 → 0 으로 clamp', async () => {
    const wallet = makeWallet('company-1', {
      creditLimit: 1_000_000,
      depositBalance: 0,
      creditUsedAmount: 900_000,
      creditExcessAmount: 300_000, // 1,000,000 - 900,000 - 300,000 = -200,000
      settleCondition: 'POST_PAYMENT',
    });
    const { service } = setupService([makeOrder(1, 'company-1')], [wallet]);

    const result = await service.getList(admin(IUserAuthority.SUPER_ADMIN), query());

    expect(result.list[0].customerSettlement.remainServiceAmount).toBe(0);
    expect(result.list[0].customerSettlement.settleCondition).toBe('POST_PAYMENT');
  });

  it('권한 화이트리스트: CORPORATE_ADMIN 은 includeSettlement=true 여도 필드 생략', async () => {
    const wallet = makeWallet('company-1', { creditLimit: 5_000_000 });
    const { service, walletFind } = setupService([makeOrder(1, 'company-1')], [wallet]);

    const result = await service.getList(admin(IUserAuthority.CORPORATE_ADMIN), query());

    expect(result.list[0].customerSettlement).toBeUndefined();
    // 권한 미달이면 wallet 조회 자체를 하지 않는다.
    expect(walletFind).not.toHaveBeenCalled();
  });

  it('includeSettlement=false → 관리자여도 필드 생략', async () => {
    const wallet = makeWallet('company-1', { creditLimit: 5_000_000 });
    const { service, walletFind } = setupService([makeOrder(1, 'company-1')], [wallet]);

    const result = await service.getList(admin(IUserAuthority.SUPER_ADMIN), query({ includeSettlement: false }));

    expect(result.list[0].customerSettlement).toBeUndefined();
    expect(walletFind).not.toHaveBeenCalled();
  });

  it('성능: distinct settlement_code 만 1회 배치 조회', async () => {
    const orders = [
      makeOrder(1, 'company-1'),
      makeOrder(2, 'company-2'),
      makeOrder(3, 'company-1'), // 중복 code
    ];
    const wallets = [
      makeWallet('company-1', { creditLimit: 1_000, depositBalance: 500, settleCondition: 'PRE_PAYMENT' }),
      makeWallet('company-2', { creditLimit: 2_000, settleCondition: 'POST_PAYMENT' }),
    ];
    const { service, walletFind } = setupService(orders, wallets);

    const result = await service.getList(admin(IUserAuthority.SUPER_ADMIN), query());

    expect(walletFind).toHaveBeenCalledTimes(1);
    const findArg = walletFind.mock.calls[0][0];
    expect(findArg.where.ownerType).toBe('SETTLEMENT_CODE');
    expect([...findArg.where.ownerId.value].sort()).toEqual(['company-1', 'company-2']);

    expect(result.list[0].customerSettlement.remainServiceAmount).toBe(1_500);
    expect(result.list[1].customerSettlement.remainServiceAmount).toBe(2_000);
    expect(result.list[2].customerSettlement).toEqual(result.list[0].customerSettlement);
  });

  it('대행발송: clientUser.settlementCode 가 user 보다 우선', async () => {
    const wallet = makeWallet('client-code', { creditLimit: 7_000, settleCondition: 'PRE_PAYMENT' });
    const order = makeOrder(1, 'owner-code', { id: 999, settlementCode: 'client-code' });
    const { service, walletFind } = setupService([order], [wallet]);

    const result = await service.getList(admin(IUserAuthority.SUPER_ADMIN), query());

    expect([...walletFind.mock.calls[0][0].where.ownerId.value]).toEqual(['client-code']);
    expect(result.list[0].customerSettlement.remainServiceAmount).toBe(7_000);
  });
});
