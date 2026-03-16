/**
 * YYYYMMDDHHmmss 또는 YYYYMMDD 형식의 날짜 문자열을 Date 객체로 변환
 * @param dateStr - 날짜 문자열 (최소 8자리 이상)
 * @returns 파싱된 Date 객체 또는 null (유효하지 않은 경우)
 */
export function parseDateString(dateStr: string | null | undefined): Date | null {
  if (!dateStr || dateStr.length < 8) {
    return null;
  }

  const year = parseInt(dateStr.substring(0, 4));
  const month = parseInt(dateStr.substring(4, 6)) - 1;
  const day = parseInt(dateStr.substring(6, 8));
  const hour = dateStr.length >= 10 ? parseInt(dateStr.substring(8, 10)) : 0;
  const minute = dateStr.length >= 12 ? parseInt(dateStr.substring(10, 12)) : 0;
  const second = dateStr.length >= 14 ? parseInt(dateStr.substring(12, 14)) : 0;

  return new Date(year, month, day, hour, minute, second);
}

/**
 * Date를 YYYYMMDD 형식 문자열로 변환
 */
export function formatDateYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * YYYYMMDD 형식 만료일이 오늘 기준 만료됐는지 판단
 * 만료일 당일까지 유효 → 만료일 다음날부터 만료
 */
export function isExpiredYMD(validTo: string): boolean {
  if (!validTo) return false;
  return formatDateYMD(new Date()) > validTo;
}
