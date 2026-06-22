import { IOrderType } from '../interface/order.type';
import { IUserAuthority } from '../../user/interface/user.authority';
import { INTERNAL_BUSINESS_NUMBERS } from '../../common/domain/company.type';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';

/**
 * 고객사 직접주문(DIRECT) 취소 통지 대상 여부.
 * GENERAL + 대행아님(clientUserId null) + 비-자사회사(businessNumber ∉ INTERNAL, null=외부취급) + 작성자 CORPORATE_ADMIN.
 */
export function isDirectCustomerCancelTarget(order: OrderEntity, orderUser: UserEntity): boolean {
  const businessNumber = orderUser.company?.businessNumber ?? null;
  const isExternalCustomer = !businessNumber || !INTERNAL_BUSINESS_NUMBERS.includes(businessNumber);
  return (
    order.type === IOrderType.GENERAL &&
    order.clientUserId == null &&
    isExternalCustomer &&
    orderUser.authority === IUserAuthority.CORPORATE_ADMIN
  );
}
