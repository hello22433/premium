export function maskBarCode(barCode: string): string {
  if (barCode.length <= 4) return '*'.repeat(barCode.length); // 너무 짧은 경우 전체 마스킹
  const start = barCode.slice(0, Math.floor((barCode.length - 4) / 2));
  const masked = '*'.repeat(4);
  const end = barCode.slice(-Math.ceil((barCode.length - 4) / 2));
  return `${start}${masked}${end}`;

}
