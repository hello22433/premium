import { isDirectCustomerCancelTarget } from './order.cancel.notification.policy';
import { IOrderType } from '../interface/order.type';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ENMAD_BUSINESS_NUMBER } from '../../common/domain/company.type';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';

const order = (o: Partial<OrderEntity> = {}): OrderEntity =>
  ({ type: IOrderType.GENERAL, clientUserId: null, ...o }) as unknown as OrderEntity;
const user = (u: Partial<UserEntity> = {}): UserEntity =>
  ({
    authority: IUserAuthority.CORPORATE_ADMIN,
    company: { businessNumber: '9999999999' },
    ...u,
  }) as unknown as UserEntity;

describe('isDirectCustomerCancelTarget', () => {
  it('GENERAL+직접+비자사회사+CORPORATE_ADMIN 이면 true', () => {
    expect(isDirectCustomerCancelTarget(order(), user())).toBe(true);
  });
  it('대행주문(clientUserId != null)이면 false', () => {
    expect(isDirectCustomerCancelTarget(order({ clientUserId: 9 }), user())).toBe(false);
  });
  it('SSG 주문이면 false', () => {
    expect(isDirectCustomerCancelTarget(order({ type: IOrderType.SSG }), user())).toBe(false);
  });
  it('자사회사(internal businessNumber)면 false', () => {
    expect(
      isDirectCustomerCancelTarget(order(), user({ company: { businessNumber: ENMAD_BUSINESS_NUMBER } as any })),
    ).toBe(false);
  });
  it('company/businessNumber 없으면 외부취급 → true', () => {
    expect(isDirectCustomerCancelTarget(order(), user({ company: undefined as any }))).toBe(true);
  });
  it('authority 가 CORPORATE_ADMIN 이 아니면 false', () => {
    expect(isDirectCustomerCancelTarget(order(), user({ authority: IUserAuthority.OPERATION_ADMIN }))).toBe(false);
  });
  it('운영담당자 지정(operationUserId != null)돼도 고객사 직접주문이면 true (operationUserId 무시)', () => {
    expect(isDirectCustomerCancelTarget(order({ operationUserId: 5 }), user())).toBe(true);
  });
});
