/**
 * 콤마로 구분된 파일경로 문자열을 배열로 변환
 * @param filePath - 콤마로 구분된 파일경로 문자열 (null/undefined 가능)
 * @returns 파일경로 배열 (빈 문자열이면 빈 배열)
 */
export function parseFilePathList(filePath: string | null | undefined): string[] {
  return filePath ? filePath.split(',') : [];
}
