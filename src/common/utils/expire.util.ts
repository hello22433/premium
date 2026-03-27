/**
 * galaxiaDuration 우선, 없으면 product.expireDay + validityStartsNextDay 기반 계산
 */
export function resolveExpireDays(
  galaxiaDuration: number | null | undefined,
  productExpireDay: number,
  validityStartsNextDay: boolean | null | undefined,
): number {
  if (galaxiaDuration) return galaxiaDuration;
  const base = productExpireDay || 0;
  return (validityStartsNextDay ?? true) ? base : base - 1;
}
