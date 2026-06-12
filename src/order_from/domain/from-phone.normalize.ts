/** 발신번호를 숫자만 남겨 정규화한다. 저장/조회/비교/UNIQUE 키 생성 전 항상 적용. */
export function normalizeFromPhone(from: string | null | undefined): string {
  if (from === null || from === undefined) return '';
  return String(from).replace(/\D/g, '');
}

/** 정규화 결과가 빈 문자열(숫자 없음)인지 여부. 400 처리에 사용. */
export function isBlankAfterNormalize(from: string | null | undefined): boolean {
  return normalizeFromPhone(from).length === 0;
}
