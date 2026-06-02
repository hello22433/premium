import { addDays } from 'date-fns';
import { couponTokenExpiry } from './expire.util';

describe('couponTokenExpiry', () => {
  test('expireAt이 있으면 +1일을 반환한다', () => {
    const expireAt = new Date('2026-03-01T00:00:00.000Z');

    expect(couponTokenExpiry(expireAt)).toEqual(addDays(expireAt, 1));
  });

  test('expireAt이 null이면 undefined를 반환한다 (5년 폴백 위임)', () => {
    expect(couponTokenExpiry(null)).toBeUndefined();
    expect(couponTokenExpiry(undefined)).toBeUndefined();
  });
});
