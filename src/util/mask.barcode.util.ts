export function maskBarCode(barCode: string): string {
  if (barCode.length <= 4) return '*'.repeat(barCode.length); // 너무 짧은 경우 전체 마스킹
  const start = barCode.slice(0, 2);
  const end = barCode.slice(-2);
  const masked = '*'.repeat(barCode.length - 4);
  return `${start}${masked}${end}`;
}
