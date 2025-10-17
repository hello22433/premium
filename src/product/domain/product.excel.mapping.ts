import { IProductType } from '../interface/product.type';
import { IProductUseStatus } from '../interface/product.status';
import { IProductSettleMethod } from '../interface/product.settle.method';

export const ProductTypeExcelMapping = (type: IProductType) => {
  if (type === IProductType.GENERAL) {
    return '일반쿠폰';
  }

  if (type === IProductType.CHOICE) {
    return '초이스쿠폰';
  }

  if (type === IProductType.DELIVERY) {
    return '배송';
  }

  if (type === IProductType.SELF) {
    return '자체';
  }

  if (type === IProductType.REAL) {
    return '실물상품';
  }
  throw new Error('정의되지 않은 상품 타입입니다.');
};

export const ProductUseStatusExcelMapping = (useStatus: IProductUseStatus) => {
  if (useStatus === IProductUseStatus.USE) {
    return '사용';
  }

  if (useStatus === IProductUseStatus.UNUSED) {
    return '미사용';
  }

  if (useStatus === IProductUseStatus.PERMANENTLY_UNUSED) {
    return '영구 미사용';
  }

  throw new Error('정의되지 않은 상태 타입입니다.');
};

export const ProductSettleMethodExcelMapping = (settleMethod: IProductSettleMethod) => {
  if (settleMethod === 'PER_EXCHANGE') {
    return '교환당';
  }

  if (settleMethod === 'PER_ISSUANCE') {
    return '발행당';
  }

  if (settleMethod === 'PER_PRODUCT') {
    return '상품당';
  }

  throw new Error('정의되지 않은 상태 타입입니다.');
};
