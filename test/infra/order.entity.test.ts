import { OrderEntity } from '../../src/entity/order.entity';
import { IOrderStatus } from '../../src/order/interface/order.status';
import { IOrderType } from '../../src/order/interface/order.type';
import { IOrderSendMethod } from '../../src/order/interface/order.send.method';

export const OrderEntityTest = (): OrderEntity => {
  return {
    createdAt: new Date(),
    deletedAt: null,
    updatedAt: new Date(),
    eventName: '',
    fromPhoneNumber: '',
    id: 0,
    registerAt: new Date(),
    requestToDestroyPersonalInfoDay: 0,
    sendAmount: 0,
    sendContent: '',
    sendMethod: IOrderSendMethod.ALIM_TALK,
    sendRequestAt: new Date(),
    sendTailText: '',
    sendTitle: '',
    settleAmount: 0,
    status: IOrderStatus.DELIVERY_CANCEL,
    type: IOrderType.GENERAL,
    userId: 0,
  };
};
