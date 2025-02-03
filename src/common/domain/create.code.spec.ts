import { CreateCode } from './create.code';

describe('create code test', () => {
  it('prevCode 가 null 이고 prefixCode 가 EP, digitNumber 가 4 일때 EP0001 return 한 경우', () => {
    const givenPrevCode = null;
    const givenPrefixCode = 'EP';
    const givenDigitNumber = 4;

    const result = CreateCode(givenPrevCode, givenPrefixCode, givenDigitNumber);

    expect(result).toBe('EP0001');
  });

  it('prevCode 가 EP0003  EP0004 return 한 경우', () => {
    const givenPrevCode = 'EP0003';
    const givenPrefixCode = 'EP';
    const givenDigitNumber = 4;

    const result = CreateCode(givenPrevCode, givenPrefixCode, givenDigitNumber);

    expect(result).toBe('EP0004');
  });

  it('prevCode 가 EBR0003  EP0004 return 한 경우', () => {
    const givenPrevCode = 'EP0003';
    const givenPrefixCode = 'EP';
    const givenDigitNumber = 4;

    const result = CreateCode(givenPrevCode, givenPrefixCode, givenDigitNumber);

    expect(result).toBe('EP0004');
  });

  it('prevCode 와 prefixCode 가 일치하지 않아 에러가 발생한 경우', () => {
    const givenPrevCode = 'EP0003';
    const givenPrefixCode = 'EPS';
    const givenDigitNumber = 4;

    expect(() => {
      CreateCode(givenPrevCode, givenPrefixCode, givenDigitNumber);
    }).toThrow(new Error('prevCode String filed must equal prefixCode'));
  });
});
