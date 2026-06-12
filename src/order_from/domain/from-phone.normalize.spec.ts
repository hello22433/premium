import { normalizeFromPhone, isBlankAfterNormalize } from './from-phone.normalize';

describe('normalizeFromPhone', () => {
  it('하이픈/공백 제거하고 숫자만 남긴다', () => {
    expect(normalizeFromPhone('02-1234-5678')).toBe('0212345678');
    expect(normalizeFromPhone(' 1644 3614 ')).toBe('16443614');
    expect(normalizeFromPhone('010-1111-2222')).toBe('01011112222');
  });
  it('null/undefined 는 빈 문자열로', () => {
    expect(normalizeFromPhone(null)).toBe('');
    expect(normalizeFromPhone(undefined)).toBe('');
  });
  it('isBlankAfterNormalize 는 숫자 없는 입력에 true', () => {
    expect(isBlankAfterNormalize('---')).toBe(true);
    expect(isBlankAfterNormalize('')).toBe(true);
    expect(isBlankAfterNormalize('010')).toBe(false);
  });
});
