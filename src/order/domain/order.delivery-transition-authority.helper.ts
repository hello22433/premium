import { IUserAuthority } from '../../user/interface/user.authority';

type DeliveryTransitionUser = {
  id: number;
  authority: IUserAuthority;
};

type DeliveryTransitionOrder = {
  userId: number;
  clientUserId: number | null;
  operationUserId: number | null;
};

export function canTransitionDelivery(
  user: DeliveryTransitionUser,
  order: DeliveryTransitionOrder,
): boolean {
  if (user.authority === IUserAuthority.SUPER_ADMIN) {
    return true;
  }

  return order.clientUserId !== null
    ? user.authority === IUserAuthority.OPERATION_ADMIN && order.operationUserId === user.id
    : user.authority === IUserAuthority.OPERATION_ADMIN;
}

export function canForceConfirmDelivery(user: DeliveryTransitionUser): boolean {
  return (
    user.authority === IUserAuthority.SUPER_ADMIN ||
    user.authority === IUserAuthority.OPERATION_ADMIN
  );
}
