import { tmpdir } from 'node:os';
import {
  createExportTempPath,
  resolveDownloadExtension,
  buildContentDispositionAttachment,
  parseFilePathList,
} from './file.util';

/**
 * 회귀: 내보내기 임시파일 경로 (감사 06-08 6-2)
 * 과거: `public/이름_리스트_<날짜>.xlsx` → 정적 노출 + 예측 가능 이름 + 동일 날짜 충돌.
 * 변경: os tmpdir + UUID → 비공개 위치 / 추측 불가 / 충돌 없음.
 */
describe('createExportTempPath', () => {
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  it('os tmpdir 하위 경로를 반환한다 (public/ 아님)', () => {
    const p = createExportTempPath('xlsx');
    expect(p.startsWith(tmpdir())).toBe(true);
    expect(p.includes('/public/')).toBe(false);
    expect(p.includes('\\public\\')).toBe(false);
  });

  it('파일명에 UUID가 포함되고 지정 확장자로 끝난다', () => {
    const p = createExportTempPath('xlsx');
    expect(p).toMatch(UUID_RE);
    expect(p.endsWith('.xlsx')).toBe(true);
  });

  it('호출마다 경로가 고유하다 (동시 다운로드 충돌 방지)', () => {
    const a = createExportTempPath('xlsx');
    const b = createExportTempPath('xlsx');
    expect(a).not.toBe(b);
  });

  it('확장자 기본값은 xlsx, 지정 시 반영된다', () => {
    expect(createExportTempPath().endsWith('.xlsx')).toBe(true);
    expect(createExportTempPath('csv').endsWith('.csv')).toBe(true);
  });
});

describe('resolveDownloadExtension (M-4)', () => {
  it.each([
    ['private/5/0123-a.xlsx', 'xlsx'],
    ['image/abc-banner.png', 'png'],
    ['private/5/0123-a.b.xlsx', 'xlsx'], // 마지막 점 기준
    ['file/1780551879605-주문서.xlsx', 'xlsx'],
  ])('%s → %s', (key, ext) => {
    expect(resolveDownloadExtension(key)).toBe(ext);
  });

  it.each([
    ['private/5/0123456789abcdef-README', 'bin'], // 확장자 없음(과거엔 경로 전체가 확장자→ENOENT 500)
    ['file/123-noext', 'bin'],
    ['private/5/name.', 'bin'], // 끝이 점 → 확장자 아님
    ['', 'bin'],
  ])('확장자 없음: %s → bin', (key, ext) => {
    expect(resolveDownloadExtension(key)).toBe(ext);
  });

  it('디렉토리에 점이 있어도 파일명(마지막 세그먼트) 기준으로만 판단한다', () => {
    expect(resolveDownloadExtension('a.b/c/noext')).toBe('bin');
    expect(resolveDownloadExtension('a.b/c/file.csv')).toBe('csv');
  });
});

describe('buildContentDispositionAttachment (LOW-1)', () => {
  it('ASCII 파일명', () => {
    expect(buildContentDispositionAttachment('report.xlsx')).toBe(
      'attachment; filename="report.xlsx"; filename*=UTF-8\'\'report.xlsx',
    );
  });

  it('한글은 RFC5987 로, ASCII 폴백은 _ 치환', () => {
    const v = buildContentDispositionAttachment('보고서.xlsx');
    expect(v).toContain('filename="___.xlsx"');
    expect(v).toContain("filename*=UTF-8''" + encodeURIComponent('보고서.xlsx'));
  });

  it('quoted-string 을 깨는 " 와 \\ 를 ASCII 폴백에서 제거(원본은 filename* 에 보존)', () => {
    const v = buildContentDispositionAttachment('a"b\\c.txt');
    expect(v).toContain('filename="abc.txt"');
    expect(v).toContain("filename*=UTF-8''" + encodeURIComponent('a"b\\c.txt'));
  });
});

describe('parseFilePathList (콤마 재조립)', () => {
  it('일반 URL 목록', () => {
    expect(parseFilePathList('https://b/a.xlsx,https://b/b.xlsx')).toEqual(['https://b/a.xlsx', 'https://b/b.xlsx']);
  });
  it('파일명에 콤마가 있으면 직전 URL 에 다시 붙인다', () => {
    expect(parseFilePathList('https://b/a,b.xlsx')).toEqual(['https://b/a,b.xlsx']);
  });
  it('null/빈문자 → 빈 배열', () => {
    expect(parseFilePathList(null)).toEqual([]);
    expect(parseFilePathList('')).toEqual([]);
  });
});
