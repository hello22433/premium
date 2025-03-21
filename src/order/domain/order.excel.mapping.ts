import { IOrderStatus } from '../interface/order.status';

export const OrderStatusExcelMapping = (status: IOrderStatus): string => {
  if (status === 'TEMP') {
    return '임시 저장';
  }

  if (status === 'DELIVERY_REQUEST') {
    return '발송 요청';
  }

  if (status === 'DELIVERY_CONFIRMED') {
    return '발송 확정';
  }

  if (status === 'DELIVERY_COMPLETE') {
    return '발송 완료';
  }

  if (status === 'DELIVERY_CANCEL') {
    return '발송 취소';
  }

  // 정의되지 않은 상태 처리
  return '';
};
