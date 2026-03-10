import { IOrderStatus } from '../interface/order.status';

const ORDER_STATUS_LABEL: Record<IOrderStatus, string> = {
  TEMP: '임시 저장',
  DELIVERY_REQUEST: '발송 요청',
  REVIEW_COMPLETE: '검토 완료',
  DELIVERY_CONFIRMED: '발송 확정',
  DELIVERY_COMPLETE: '발송 완료',
  DELIVERY_CANCEL: '발송 취소',
};

export const OrderStatusExcelMapping = (status: IOrderStatus): string =>
  ORDER_STATUS_LABEL[status] ?? '';
