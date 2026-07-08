import { BadRequestException } from '@nestjs/common';
import { addDays } from 'date-fns';

/**
 * 유효기간 범위 필터 입력 검증: 둘 다 전송되었고 하한 > 상한이면 400.
 *
 * 주의: expireDayMin/Max 는 사용자가 직접 입력하는 값이 아니라 프론트의 유효기간 프리셋
 * (30일=29/31, 60일=59/61, 5년=1824/1826 등) 상수로 전송된다. 따라서 이 예외는 정상
 * 사용자 조작으로는 발생하지 않고 프론트 버그/API 직접 호출 시에만 도달하므로, 메시지는
 * 사용자 친화 문구가 아니라 프론트 개발자 디버깅용으로 둔다.
 */
export function assertExpireDayRangeValid(expireDayMin: number | undefined, expireDayMax: number | undefined): void {
  if (expireDayMin !== undefined && expireDayMax !== undefined && expireDayMin > expireDayMax) {
    throw new BadRequestException('유효기간의 범위가 잘못 설정되었습니다.');
  }
}

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
