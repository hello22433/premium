export const CreateTransactionId = (orderId: number, orderDeliveryId: number) => {
  return `ENM${orderId}DELIVERY${orderDeliveryId}`;
};
