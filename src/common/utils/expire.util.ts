import { addDays } from 'date-fns';

/**
 * galaxiaDuration 우선, 없으면 product.expireDay + validityStartsNextDay 기반 계산
 */
export function resolveExpireDays(
  galaxiaDuration: number | null | undefined,
  productExpireDay: number,
  validityStartsNextDay: boolean | null | undefined,
): number {
  if (galaxiaDuration != null) return galaxiaDuration;
  const base = productExpireDay || 0;
  return (validityStartsNextDay ?? true) ? base : base - 1;
}

/**
 * 쿠폰 발송 링크 토큰의 만료시각 = 쿠폰 실제 만료일(expireAt) + 1일.
 * (+1일: _exp가 millisecond cutoff라 만료 당일 끝까지 링크 유효하도록 여유)
 * expireAt이 없으면 undefined → encryptJson이 5년 폴백 적용.
 */
export function couponTokenExpiry(expireAt: Date | null | undefined): Date | undefined {
  return expireAt ? addDays(expireAt, 1) : undefined;
}
