import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 스트리밍 후 즉시 삭제되는 1회용 내보내기 파일의 디스크 경로를 만든다.
 * os tmpdir(정적 서빙 안 됨) + UUID 조합으로 한 번에 세 가지를 막는다:
 *  ① public/ 정적 노출 제거(애초에 웹으로 안 닿는 위치)
 *  ② 예측 가능한 파일명(날짜 기반) 열거 차단
 *  ③ 동일 날짜 동시 다운로드 시 파일명 충돌(덮어쓰기) 방지
 * 사용자 다운로드명(Content-Disposition)은 호출부가 별도 fileName으로 지정하므로,
 * 디스크 파일명이 무작위여도 사용자 경험에는 영향이 없다.
 */
export function createExportTempPath(extension = 'xlsx'): string {
  return join(tmpdir(), `epopkon-export-${randomUUID()}.${extension}`);
}

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
