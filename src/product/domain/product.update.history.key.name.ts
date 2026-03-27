export const ProductUpdateHistoryKeyName = (key: string): string => {
  if (key === 'partnerCompanyCode') {
    return '협력사 상품 코드';
  }

  if (key === 'partnerCompanyId') {
    return '협력사';
  }

  if (key === 'brandId') {
    return '브랜드';
  }

  if (key === 'name') {
    return '이름';
  }

  if (key === 'price') {
    return '가격';
  }

  if (key === 'expireDay') {
    return '만료일 수';
  }

  if (key === 'category') {
    return '상품군';
  }

  if (key === 'classificationId') {
    return '대분류';
  }

  if (key === 'settleMethod') {
    return '정산 방법';
  }

  if (key === 'settlePercent') {
    return '정산 조건';
  }

  if (key === 'imagePath') {
    return '이미지';
  }

  if (key === 'type') {
    return '상품 유형';
  }

  if (key === 'memo') {
    return '유의사항';
  }

  if (key === 'useStatus') {
    return '상품 상태';
  }

  if (key === 'galaxiaDuration') {
    return 'GALAXIA 유효기간';
  }

  if (key === 'reason') {
    return '수정사유';
  }
  throw new Error("can't mapping key ");
};
