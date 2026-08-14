import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserStatus } from '../../user/interface/user.status';
import { UserAuthListDefault } from '../../user_info/domain/user.auth.list.default';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { IOrderType } from '../interface/order.type';
import { IOrderStatus } from '../interface/order.status';

type DeliveryTransitionUser = {
  id: number;
  authority: IUserAuthority;
  status: IUserStatus;
  authorityList: string | null;
};

type DeliveryTransitionOrder = {
  userId: number;
  clientUserId: number | null;
  operationUserId: number | null;
  type: IOrderType;
};

export function canTransitionDelivery(user: DeliveryTransitionUser, order: DeliveryTransitionOrder): boolean {
  if (user.status !== IUserStatus.USED) {
    return false;
  }

  const requiredAuthority = order.type === IOrderType.SSG ? UserAuthSubEnum.SEND_SSG : UserAuthSubEnum.SEND_GENERAL;
  if (!UserAuthListDefault(user.authority, user.authorityList).includes(requiredAuthority)) {
    return false;
  }

  if (user.authority === IUserAuthority.SUPER_ADMIN) {
    return true;
  }

  return order.clientUserId !== null
    ? user.authority === IUserAuthority.OPERATION_ADMIN && order.operationUserId === user.id
    : user.authority === IUserAuthority.OPERATION_ADMIN;
}

/**
 * /order/detail 응답에 SSG 행사잔액 이상탐지(ssgBalanceCheck)를 노출해도 되는지.
 * 민감 재무데이터라 발송확정 권한자에게만. 게이트 3중:
 * (1) 타입 SSG (2) 발송확정 전(REVIEW_COMPLETE) (3) 발송확정 권한(canTransitionDelivery).
 */
export function shouldExposeSsgBalanceCheck(
  user: DeliveryTransitionUser,
  order: DeliveryTransitionOrder & { status: IOrderStatus },
): boolean {
  return (
    order.type === IOrderType.SSG && order.status === IOrderStatus.REVIEW_COMPLETE && canTransitionDelivery(user, order)
  );
}
