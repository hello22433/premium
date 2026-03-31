export const CreateTransactionId = (orderId: number, orderDeliveryId: number) => {
  return `ENM${orderId}D${orderDeliveryId}`;
};

export const CreateResendTransactionId = (orderId: number, orderDeliveryId: number, retryCount: number) => {
  return `${CreateTransactionId(orderId, orderDeliveryId)}R${retryCount}`;
};

export const CreateApiTransactionId = (orderId: number, orderDeliveryId: number) => {
  return `API${orderId}D${orderDeliveryId}`;
};
