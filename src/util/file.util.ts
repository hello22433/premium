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

/**
 * S3 key 로부터 로컬 임시파일에 붙일 확장자를 구한다.
 * key 전체가 아니라 마지막 세그먼트(파일명)에 '.' 이 있을 때만 확장자로 인정한다.
 * (과거엔 key.split('.') 를 써서, 확장자 없는 key 면 경로 전체가 확장자가 되어 존재하지 않는
 *  디렉토리 경로를 만들고 createWriteStream 이 ENOENT 로 실패 → 다운로드 500 이 났다.)
 * 사용자에게 보이는 이름은 Content-Disposition 의 fileName 이므로 로컬 확장자는 표시와 무관하다.
 */
export function resolveDownloadExtension(key: string): string {
  const base = key.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1) : 'bin';
}

/**
 * 다운로드용 Content-Disposition(attachment) 헤더 값을 만든다.
 *  - 한글 등 비ASCII 는 RFC5987 filename*=UTF-8'' 로.
 *  - 구형 클라이언트용 ASCII filename 도 병기하되, quoted-string 을 깨는 " 와 \ 를 제거한다.
 */
export function buildContentDispositionAttachment(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '');
  // ★ encodeURIComponent 는 `'`·`(`·`)`·`*` 를 안 바꿄다. 그런데 RFC5987 의 attr-char 에는 이 넣이 없어
  //   그대로 두면 엄격한 클라이언트가 filename* 를 통째로 무효로 본다(예: `계약서(최종).pdf` →
  //   밑줄로 뭉개는 ASCII 폴백으로 떨어진다). 네 글자만 마저 인코딩한다.
  //   `!`·`~`·`-`·`_`·`.` 는 attr-char 에 있으므로 건드리지 않는다.
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 첨부 URL 배열을 저장용 문자열로 직렬화해도 원래 배열 그대로 복원되는지 확인한다.
 *
 * ★ 왜 필요한가 — 저장은 join(',') 이고 복원은 parseFilePathList 인데, 이 둘의 "URL 경계" 판단이
 *   검증 단계(new URL)와 다르다. 그래서 배열 원소 하나에 `,https://...` 를 심으면
 *   쓰기 검증은 URL 1개로 보고 통과시키지만 저장 후에는 2개로 복원된다(=검증 안 거친 첨부가 생김).
 *   실측: `https://{버킷}/private/5/a.png?x=,https://{버킷}/private/77/secret.pdf` 1개 →
 *   저장·복원 후 2개(private/5/a.png, private/77/secret.pdf), 개수 상한도 10 → 20 으로 우회됐다.
 *
 *   파일명에 정상적으로 콤마가 들어간 경우는 parseFilePathList 가 다시 이어붙이므로 왕복이 보존된다.
 *   즉 이 검사는 정상 입력을 막지 않고 밀반입만 걸러낸다.
 */
export function isFilePathListRoundTripSafe(urls: string[]): boolean {
  const restored = parseFilePathList(urls.join(','));
  return restored.length === urls.length && restored.every((url, i) => url === urls[i]);
}

/**
 * S3 key 를 로그에 남길 수 있는 형태로 줄인다 — 객체는 식별하되 원본 파일명은 남기지 않는다.
 *
 * 접근 로그에서 첨부 URL 을 통째로 가리면(logger.middleware) 장애가 났을 때 "어느 파일이었나" 를
 * 되짚을 단서가 0개가 된다. 그렇다고 애플리케이션 로그에 key 를 그대로 쓰면 `{uuid}-{원본명}` 의
 * 원본명이 다시 새어 같은 값을 한쪽에서만 가리는 꼴이 된다. 그래서 식별자 앞부분만 남긴다.
 *   private/5/0123456789abcdef-해지 신청서.pdf  →  private/5/01234567…
 */
export function maskStorageKeyForLog(key: string): string {
  const segments = key.split('/');
  const base = segments.pop() ?? '';
  const dash = base.indexOf('-');
  // `{식별자}-{원본명}` 규격이 아니면 통째로 가린다(이름만 있는 형태일 수 있다).
  const masked = dash > 0 ? `${base.slice(0, Math.min(dash, 8))}…` : '***';
  return [...segments, masked].join('/');
}

/**
 * 로그 한 줄에 넣기 전에 줄바꿈·제어문자를 없앨다 — 로그 라인 주입 방지.
 *
 * key 는 클라이언트가 준 URL 의 pathname 을 decodeURIComponent 한 값이라 `%0a` 를 넣으면 실제
 * 개행이 된다(실측 확인함). 그대로 로그에 쓰면 가짜 로그 줄을 만들어 넣을 수 있다.
 * C0 제어문자·DEL 에 더해 유니코드 줄바꿈(U+0085, U+2028, U+2029)까지 막는다 —
 * 일부 로그 수집기·JSON 파서가 이것들도 줄바꿈으로 해석한다.
 */
export function sanitizeForLog(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ');
}
