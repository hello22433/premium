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
