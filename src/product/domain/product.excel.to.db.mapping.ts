import { IProductType } from '../interface/product.type';
import { IProductUseStatus } from '../interface/product.status';
import { IProductSettleMethod } from '../interface/product.settle.method';

export const ProductTypeExcelToDBMapping = (type: string): IProductType => {
  if (type === '일반쿠폰') {
    return IProductType.GENERAL;
  }

  if (type === '초이스쿠폰') {
    return IProductType.CHOICE;
  }

  if (type === '배송') {
    return IProductType.DELIVERY;
  }

  if (type === '자체') {
    return IProductType.SELF;
  }

  if (type === '실물상품') {
    return IProductType.REAL;
  }
  throw new Error('정의되지 않은 상품 타입입니다.');
};

export const ProductUseStatusExcelToDBMapping = (useStatus: string): IProductUseStatus => {
  if (useStatus === '사용') {
    return IProductUseStatus.USE;
  }

  if (useStatus === '미사용') {
    return IProductUseStatus.UNUSED;
  }

  if (useStatus === '영구 미사용') {
    return IProductUseStatus.PERMANENTLY_UNUSED;
  }

  throw new Error('정의되지 않은 상태 타입입니다.');
};

export const ProductSettleMethodExcelToDbMapping = (settleMethod: string): IProductSettleMethod => {
  if (settleMethod === '교환당') {
    return 'PER_EXCHANGE';
  }

  if (settleMethod === '발행당') {
    return 'PER_ISSUANCE';
  }

  if (settleMethod === '상품당') {
    return 'PER_PRODUCT';
  }

  throw new Error('정의되지 않은 상태 타입입니다.');
};
