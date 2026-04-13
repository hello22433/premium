/**
 * 콤마로 구분된 파일경로 문자열을 배열로 변환.
 * 파일명에 콤마가 포함된 경우를 대비해, https:// 또는 http:// 로 시작하지 않는 조각은
 * 직전 URL의 파일명 일부로 간주해 다시 이어붙인다.
 */
export function parseFilePathList(filePath: string | null | undefined): string[] {
  if (!filePath) return [];

  const chunks = filePath.split(',');
  const urls: string[] = [];

  for (const chunk of chunks) {
    const isUrlStart = chunk.startsWith('https://') || chunk.startsWith('http://');
    const prev = urls[urls.length - 1];
    const prevIsUrl = !!prev && (prev.startsWith('https://') || prev.startsWith('http://'));

    if (isUrlStart || urls.length === 0 || !prevIsUrl) {
      urls.push(chunk);
    } else {
      urls[urls.length - 1] += ',' + chunk;
    }
  }

  return urls;
}
