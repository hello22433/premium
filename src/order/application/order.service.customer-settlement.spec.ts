import { OrderService } from './order.service';
import { IOrderType } from '../interface/order.type';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

/**
 * getCustomerSettlement() — 발송관리 고객사 호버 툴팁용 정산정보 지연 로딩 엔드포인트
 *
 * 검증 대상 (프론트 수용 조건):
 * - settleCondition 은 항상 wallet_account.settle_condition (non-null)
 * - remainServiceAmount = creditLimit + depositBalance − creditUsedAmount − creditExcessAmount, 0-clamp
 * - wallet_account 미존재 / 정산코드 미부여 주문 → 응답 목록에서 생략
 * - 권한 화이트리스트: SUPER_ADMIN / OPERATION_ADMIN 만 값을 받는다
 * - distinct settlement_code 1회 배치 조회 (주문 수와 무관하게 쿼리 수 고정)
 * - 조회 범위(view_scope) 필터를 태워 타사 주문 id 순회(IDOR) 차단
 * - order.type 필터로 교차 유형 조회 차단 (SEND_GENERAL 권한으로 SSG 주문 id 조회 불가)
 */

const admin = (authority: IUserAuthority) => ({ id: 1, email: 'a@test.com', authority }) as any;

const req = (ids: number[], type: IOrderType = IOrderType.GENERAL) => ({ ids, type }) as any;

const makeOrder = (
  id: number,
  settlementCode: string | null,
  options: { clientUser?: { id: number; settlementCode: string }; type?: IOrderType } = {},
) => ({
  id,
  type: options.type ?? IOrderType.GENERAL,
  clientUser: options.clientUser ?? null,
  user: { id: 100 + id, settlementCode: settlementCode ?? '' },
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
  // where/andWhere 파라미터를 실제로 반영하는 페이크 — order.type 필터가 빠지면 아래 교차 유형 테스트가 깨진다.
  let typeFilter: IOrderType | undefined;
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((condition: string, params?: Record<string, unknown>) => {
      if (condition.includes('order.type')) {
        typeFilter = params?.type as IOrderType;
      }
      return qb;
    }),
    getMany: jest.fn(() =>
      Promise.resolve(orders.filter((order) => typeFilter === undefined || order.type === typeFilter)),
    ),
  };

  const walletFind = jest.fn().mockResolvedValue(wallets);
  const viewScopeFilter = jest.fn().mockReturnValue(qb);

  const service = Object.create(OrderService.prototype) as any;
  service.orderRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  service.userRepository = {
    findOne: jest.fn().mockResolvedValue({ id: 1, companyId: null, departmentId: null }),
  };
  service.userViewScopeRepository = {
    findOne: jest.fn().mockResolvedValue({ scopeType: ViewScopeType.ALL, getDeptIdList: () => [] }),
  };
  service.walletAccountRepository = { find: walletFind };
  service['applyViewScopeFilter'] = viewScopeFilter;

  return { service, walletFind, viewScopeFilter, qb };
};

describe('OrderService getCustomerSettlement', () => {
  it('정상: orderId + settleCondition + remainServiceAmount(정수) 반환', async () => {
    const wallet = makeWallet('company-1', {
      creditLimit: 10_000_000,
      depositBalance: 2_345_678,
      settleCondition: 'PRE_PAYMENT',
    });
    const { service } = setupService([makeOrder(1, 'company-1')], [wallet]);

    const result = await service.getCustomerSettlement(admin(IUserAuthority.SUPER_ADMIN), req([1]));

    expect(result.list).toEqual([
      { orderId: 1, settleCondition: 'PRE_PAYMENT', remainServiceAmount: 12_345_678 },
    ]);
  });

  it('wallet_account 미존재 → 해당 주문은 목록에서 생략', async () => {
    const { service } = setupService([makeOrder(1, 'company-nowallet')], []);

    const result = await service.getCustomerSettlement(admin(IUserAuthority.OPERATION_ADMIN), req([1]));

    expect(result.list).toEqual([]);
  });

  it('settlement_code 미부여(빈 문자열) → wallet 조회 자체를 하지 않고 생략', async () => {
    const { service, walletFind } = setupService([makeOrder(1, null)], []);

    const result = await service.getCustomerSettlement(admin(IUserAuthority.SUPER_ADMIN), req([1]));

    expect(result.list).toEqual([]);
    expect(walletFind).not.toHaveBeenCalled();
  });

  it('remainServiceAmount 음수 계산 → 0 으로 clamp', async () => {
    const wallet = makeWallet('company-1', {
      creditLimit: 1_000_000,
      creditUsedAmount: 900_000,
      creditExcessAmount: 300_000, // 1,000,000 - 900,000 - 300,000 = -200,000
      settleCondition: 'POST_PAYMENT',
    });
    const { service } = setupService([makeOrder(1, 'company-1')], [wallet]);

    const result = await service.getCustomerSettlement(admin(IUserAuthority.SUPER_ADMIN), req([1]));

    expect(result.list[0].remainServiceAmount).toBe(0);
    expect(result.list[0].settleCondition).toBe('POST_PAYMENT');
  });

  it('권한 화이트리스트: CORPORATE_ADMIN 은 빈 목록 + 조회 자체를 하지 않는다', async () => {
    const wallet = makeWallet('company-1', { creditLimit: 5_000_000 });
    const { service, walletFind, qb } = setupService([makeOrder(1, 'company-1')], [wallet]);

    const result = await service.getCustomerSettlement(admin(IUserAuthority.CORPORATE_ADMIN), req([1]));

    expect(result.list).toEqual([]);
    expect(qb.getMany).not.toHaveBeenCalled();
    expect(walletFind).not.toHaveBeenCalled();
  });

  it('ids 가 비면 조회 없이 빈 목록', async () => {
    const { service, walletFind, qb } = setupService([], []);

    const result = await service.getCustomerSettlement(admin(IUserAuthority.SUPER_ADMIN), req([]));

    expect(result.list).toEqual([]);
    expect(qb.getMany).not.toHaveBeenCalled();
    expect(walletFind).not.toHaveBeenCalled();
  });

  it('IDOR 차단: 조회 범위(view_scope) 필터를 적용한다', async () => {
    const { service, viewScopeFilter } = setupService([makeOrder(1, 'company-1')], []);

    await service.getCustomerSettlement(admin(IUserAuthority.OPERATION_ADMIN), req([1]));

    expect(viewScopeFilter).toHaveBeenCalledTimes(1);
  });

  it('교차 유형 차단: type=GENERAL 로 SSG 주문 id 를 요청하면 빈 목록', async () => {
    const wallet = makeWallet('company-1', { creditLimit: 5_000_000 });
    const ssgOrder = makeOrder(1, 'company-1', { type: IOrderType.SSG });
    const { service, walletFind, qb } = setupService([ssgOrder], [wallet]);

    const result = await service.getCustomerSettlement(
      admin(IUserAuthority.OPERATION_ADMIN),
      req([1], IOrderType.GENERAL),
    );

    expect(result.list).toEqual([]);
    // order.type 조건이 실제 쿼리에 걸렸는지 (조건이 빠지면 위 결과가 채워져 테스트가 깨진다)
    expect(qb.andWhere).toHaveBeenCalledWith('order.type = :type', { type: IOrderType.GENERAL });
    expect(walletFind).not.toHaveBeenCalled();
  });

  it('교차 유형 차단: type=SSG 로 요청하면 SSG 주문만 반환', async () => {
    const wallets = [makeWallet('company-1', { creditLimit: 5_000_000, settleCondition: 'POST_PAYMENT' })];
    const orders = [
      makeOrder(1, 'company-1', { type: IOrderType.GENERAL }),
      makeOrder(2, 'company-1', { type: IOrderType.SSG }),
    ];
    const { service } = setupService(orders, wallets);

    const result = await service.getCustomerSettlement(admin(IUserAuthority.SUPER_ADMIN), req([1, 2], IOrderType.SSG));

    expect(result.list).toEqual([
      { orderId: 2, settleCondition: 'POST_PAYMENT', remainServiceAmount: 5_000_000 },
    ]);
  });

  it('성능: 중복 정산코드는 distinct 로 묶어 wallet 1회 배치 조회', async () => {
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

    const result = await service.getCustomerSettlement(admin(IUserAuthority.SUPER_ADMIN), req([1, 2, 3]));

    expect(walletFind).toHaveBeenCalledTimes(1);
    const findArg = walletFind.mock.calls[0][0];
    expect(findArg.where.ownerType).toBe('SETTLEMENT_CODE');
    expect([...findArg.where.ownerId.value].sort()).toEqual(['company-1', 'company-2']);

    expect(result.list).toEqual([
      { orderId: 1, settleCondition: 'PRE_PAYMENT', remainServiceAmount: 1_500 },
      { orderId: 2, settleCondition: 'POST_PAYMENT', remainServiceAmount: 2_000 },
      { orderId: 3, settleCondition: 'PRE_PAYMENT', remainServiceAmount: 1_500 },
    ]);
  });

  it('대행발송: clientUser.settlementCode 가 user 보다 우선', async () => {
    const wallet = makeWallet('client-code', { creditLimit: 7_000, settleCondition: 'PRE_PAYMENT' });
    const order = makeOrder(1, 'owner-code', { clientUser: { id: 999, settlementCode: 'client-code' } });
    const { service, walletFind } = setupService([order], [wallet]);

    const result = await service.getCustomerSettlement(admin(IUserAuthority.SUPER_ADMIN), req([1]));

    expect([...walletFind.mock.calls[0][0].where.ownerId.value]).toEqual(['client-code']);
    expect(result.list[0].remainServiceAmount).toBe(7_000);
  });
});
