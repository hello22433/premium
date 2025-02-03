import { ProductEntity } from '../../src/entity/product.entity';

export const ProductEntityTest = (): ProductEntity => {
  return {
    brand: undefined,
    brandId: 0,
    category: '',
    classification: '',
    code: '',
    couponMethod: '',
    createdAt: new Date(),
    deletedAt: null,
    expireDay: 0,
    id: 0,
    imagePath: '',
    name: '',
    partnerCompany: undefined,
    partnerCompanyId: 0,
    price: 0,
    settleMethod: 'PER_EXCHANGE',
    settlePercent: 0,
    type: 'GENERAL',
    updatedAt: new Date(),
    memo: 'dd',
    partnerCompanyCode: '',
  };
};
