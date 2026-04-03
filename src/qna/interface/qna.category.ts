export enum IQnaMainCategory {
  PRODUCT_INQUIRY = 'PRODUCT_INQUIRY',
  PROOF = 'PROOF',
  CS = 'CS',
  ETC = 'ETC',
}

export const QnaMainCategoryKo: Record<IQnaMainCategory, string> = {
  [IQnaMainCategory.PRODUCT_INQUIRY]: '상품문의',
  [IQnaMainCategory.PROOF]: '증빙',
  [IQnaMainCategory.CS]: 'CS접수',
  [IQnaMainCategory.ETC]: '기타',
};

export enum IQnaSubCategory {
  RESEND = 'RESEND',
  NUMBER_CHANGE = 'NUMBER_CHANGE',
  DISPOSE = 'DISPOSE',
}

export const QnaSubCategoryKo: Record<IQnaSubCategory, string> = {
  [IQnaSubCategory.RESEND]: '재발송',
  [IQnaSubCategory.NUMBER_CHANGE]: '번호변경',
  [IQnaSubCategory.DISPOSE]: '폐기',
};
