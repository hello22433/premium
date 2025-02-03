import { NumberToDigitsString } from '../../util/digits';

export const CreateCode = (prevCode: string | null, prefixCode: string, digitNumber: number): string => {
  const digitNumberString = '0'.repeat(digitNumber - 1);
  if (!prevCode) {
    return `${prefixCode}${digitNumberString}1`;
  }
  if (prevCode.substring(0, prefixCode.length) !== prefixCode) {
    throw new Error('prevCode String filed must equal prefixCode');
  }

  const numberPrevCode = +prevCode.substring(prefixCode.length);

  const prevCodePlusOne = numberPrevCode + 1;

  return `${prefixCode}${NumberToDigitsString(prevCodePlusOne, digitNumber)}`;
};
