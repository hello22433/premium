import { BrandEntity } from '../../src/entity/brand.entity';

export const BrandEntityTest = (): BrandEntity => {
  return {
    id: 0,
    code: '',
    isUsed: false,
    nameEnglish: '한국어',
    nameKorean: '영문',

    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
};
