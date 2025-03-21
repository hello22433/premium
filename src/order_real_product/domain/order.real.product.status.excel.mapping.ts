import { IOrderRealProductStatus } from '../interface/order.real.product.status';

export const OrderRealProductStatusExcelMapping = (status: IOrderRealProductStatus): string => {
  if (status === 'ORDER_PENDING') {
    return '확정 대기';
  }

  if (status === 'ORDER_CONFIRM') {
    return '주문 확정';
  }

  if (status === 'ORDER_COMPLETED') {
    return '발주 완료';
  }

  if (status === 'STORAGE_COMPLETED') {
    return '입고 완료';
  }

  if (status === 'DELIVERY_PROGRESS') {
    return '배송중';
  }

  if (status === 'DELIVERY_COMPLETED') {
    return '배송 완료';
  }

  if (status === 'ORDER_CANCELED') {
    return '주문 취소';
  }

  // 정의되지 않은 상태 처리
  return '';
};
