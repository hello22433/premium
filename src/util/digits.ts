export function CountDigits(number: number): number {
  return Math.abs(number).toString().length;
}

export function NumberToDigitsString(number: number, digits: number): string {
  let str: string = Math.abs(number).toString();
  while (str.length < digits) {
    str = '0' + str;
  }

  return str;
}
