import { tmpdir } from 'node:os';
import {
  createExportTempPath,
  resolveDownloadExtension,
  buildContentDispositionAttachment,
  parseFilePathList,
  isFilePathListRoundTripSafe,
  maskStorageKeyForLog,
  sanitizeForLog,
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

describe('isFilePathListRoundTripSafe — 저장·복원 왕복 동일성', () => {
  const HOST = 'epopkon-premium.s3.ap-northeast-2.amazonaws.com';

  it('일반 첨부 목록은 통과한다', () => {
    expect(
      isFilePathListRoundTripSafe([`https://${HOST}/private/5/uuid-a.png`, `https://${HOST}/private/5/uuid-b.pdf`]),
    ).toBe(true);
  });

  it('빈 배열도 통과한다', () => {
    expect(isFilePathListRoundTripSafe([])).toBe(true);
  });

  // ★ 정상 사용을 막지 않는다는 것까지 고정한다. parseFilePathList 가 URL 로 시작하지 않는 조각을
  //   앞 URL 에 되붙이므로, 파일명 안의 콤마는 왕복이 보존된다.
  it('파일명에 콤마가 들어간 정상 첨부는 통과한다', () => {
    expect(isFilePathListRoundTripSafe([`https://${HOST}/private/5/uuid-보고서,최종.pdf`])).toBe(true);
  });

  it('파일명 콤마 + 여러 첨부 조합도 통과한다', () => {
    expect(
      isFilePathListRoundTripSafe([`https://${HOST}/private/5/uuid-a,b.png`, `https://${HOST}/private/5/uuid-c.pdf`]),
    ).toBe(true);
  });

  // ★ 밀반입: 원소 1개가 저장·복원 후 2개가 된다 → 소유 검증을 안 거친 첨부가 생긴다.
  it('원소 안에 `,https://` 를 심으면 거부한다 (쿼리스트링으로 가린 형태)', () => {
    expect(
      isFilePathListRoundTripSafe([`https://${HOST}/private/5/a.png?x=,https://${HOST}/private/77/secret.pdf`]),
    ).toBe(false);
  });

  it('쿼리 없이 경로에 바로 이어붙인 형태도 거부한다', () => {
    expect(isFilePathListRoundTripSafe([`https://${HOST}/private/5/a,https://${HOST}/private/77/secret.pdf`])).toBe(
      false,
    );
  });

  it('http:// 로 심어도 거부한다 (parseFilePathList 는 http 도 URL 시작으로 본다)', () => {
    expect(isFilePathListRoundTripSafe([`https://${HOST}/private/5/a.png?x=,http://${HOST}/private/77/s.pdf`])).toBe(
      false,
    );
  });

  // ★ 길이만 비교하면 통과하는 입력이 실재한다 — 원소별 비교(every)를 지워도 안 빨개지던 자리.
  //   입력 2개 → 복원 2개인데 경계가 밀려 내용이 다르다.
  it('길이는 같은데 경계가 밀린 입력을 거부한다 (원소별 비교가 필요한 이유)', () => {
    const shifted = [`https://${HOST}/private/10/f,https://${HOST}/private/99/s.pdf`, 'tail'];
    expect(isFilePathListRoundTripSafe(shifted)).toBe(false);
  });

  it('정상 첨부 사이에 밀반입 원소가 하나만 섞여도 거부한다', () => {
    expect(
      isFilePathListRoundTripSafe([
        `https://${HOST}/private/5/uuid-a.png`,
        `https://${HOST}/private/5/b.png?x=,https://${HOST}/private/77/secret.pdf`,
      ]),
    ).toBe(false);
  });
});

describe('maskStorageKeyForLog — 로그용 key 축약', () => {
  // 접근 로그에서 첨부 URL 을 통째로 가리는 대신, 애플리케이션 로그에는 '객체는 식별하되 이름은 없는'
  // 형태를 남긴다. 여기서 원본명이 새면 한쪽만 가린 꼴이 된다.
  it('원본 파일명을 남기지 않는다', () => {
    const out = maskStorageKeyForLog('private/5/0123456789abcdef-해지 신청서.pdf');
    expect(out).toBe('private/5/01234567…');
    expect(out).not.toContain('해지');
    expect(out).not.toContain('.pdf');
  });

  it('업로더 경로는 남겨 추적이 되게 한다', () => {
    expect(maskStorageKeyForLog('private/5/abc-a.png')).toContain('private/5/');
  });

  it('식별자-이름 규격이 아니면 통째로 가린다', () => {
    expect(maskStorageKeyForLog('private/5/README')).toBe('private/5/***');
  });

  it('레거시 공개 key 도 이름을 남기지 않는다', () => {
    expect(maskStorageKeyForLog('image/abcdef0123-사업자등록증.png')).toBe('image/abcdef01…');
  });
});

describe('buildContentDispositionAttachment — RFC5987 attr-char', () => {
  // ★ encodeURIComponent 는 `'`·`(`·`)`·`*` 를 안 바꾼다. RFC5987 attr-char 에는 이 넷이 없어서
  //   그대로 두면 엄격한 클라이언트가 filename* 를 무효로 보고 밑줄 ASCII 폴백으로 떨어진다.
  it.each([
    ['계약서(최종).pdf', '('],
    ["철수's 보고서.pdf", "'"],
    ['보고서*.pdf', '*'],
  ])('filename* 에 %s 의 `%s` 가 원문으로 남지 않는다', (name, ch) => {
    const out = buildContentDispositionAttachment(name);
    const encoded = out.split("filename*=UTF-8''")[1];
    expect(encoded).not.toContain(ch);
  });

  it('attr-char 에 있는 문자(!~-_.)는 굳이 인코딩하지 않는다', () => {
    const encoded = buildContentDispositionAttachment('a-b_c.d!e~f.pdf').split("filename*=UTF-8''")[1];
    expect(encoded).toBe('a-b_c.d!e~f.pdf');
  });

  it('ASCII 폴백은 그대로 유지된다 (비ASCII → _, 따옴표/역슬래시 제거)', () => {
    // 한글은 전부 비ASCII 라 _ 로, 그 뒤 quoted-string 을 깨는 " 와 \ 를 제거 → ___.pdf
    expect(buildContentDispositionAttachment('보"고\서.pdf')).toContain('filename="___.pdf"');
  });
});

describe('sanitizeForLog — 로그 라인 주입 차단', () => {
  it('개행을 공백으로 바꾼다 (가짜 로그 줄 방지)', () => {
    expect(sanitizeForLog('private/5/a\nfake-log')).toBe('private/5/a fake-log');
  });

  it('CR·탭·NUL 등 C0 제어문자도 제거한다', () => {
    expect(sanitizeForLog('a\rb\tc\u0000d')).toBe('a b c d');
  });

  // 예시 세 개(\n \r \0)만 막으면 "제어문자" 를 다 막은 게 아니다 — 유니코드 줄바꿈이 남는다.
  it('유니코드 줄바꿈(U+0085 · U+2028 · U+2029)도 제거한다', () => {
    expect(sanitizeForLog('a\u0085b\u2028c\u2029d')).toBe('a b c d');
  });

  it('정상 문자는 건드리지 않는다', () => {
    expect(sanitizeForLog('private/5/01234567… 해지 신청서')).toBe('private/5/01234567… 해지 신청서');
  });
});

/**
 * 로그 안전 회귀 — "마스킹했다" 와 "로그 줄 위조를 막았다" 는 다른 약속이다.
 * 예전엔 마지막 세그먼트만 가리고 디렉토리 세그먼트는 원문 그대로 이어붙여, 주석은 제어문자를 없앤다고
 * 하는데 실제로는 개행이 그대로 나갔다. 두 약속을 한 함수가 지키게 바꿨고 이 스펙이 그걸 잠근다.
 */
describe('maskStorageKeyForLog / sanitizeForLog — 로그 줄 위조 차단', () => {
  it('★디렉토리 세그먼트의 개행도 없앤다 (마스킹만으로는 안 막힌다)', () => {
    const key = 'private/5\nERROR 가짜줄/0123456789abcdef-대외비.pdf';
    const masked = maskStorageKeyForLog(key);
    expect(masked).not.toContain('\n');
    expect(masked).not.toContain('대외비');
  });

  it('★파일명 쪽 개행도 없앤다', () => {
    const masked = maskStorageKeyForLog('private/5/aa\r\nbb-x.pdf');
    expect(masked).not.toContain('\n');
    expect(masked).not.toContain('\r');
  });

  it('유니코드 줄바꿈(U+2028/U+2029/U+0085)도 없앤다', () => {
    expect(sanitizeForLog('a\u2028b\u2029c\u0085d')).toBe('a b c d');
  });

  it('★문자열이 아닌 값이 와도 던지지 않는다 (catch 안에서 로그가 통째로 사라지면 안 된다)', () => {
    expect(() => sanitizeForLog(undefined as unknown as string)).not.toThrow();
    expect(() => sanitizeForLog(null as unknown as string)).not.toThrow();
    expect(() => sanitizeForLog({ a: 1 } as unknown as string)).not.toThrow();
  });

  it('아주 긴 값은 잘린다 (key 는 클라이언트가 정한다)', () => {
    const out = sanitizeForLog('x'.repeat(5000));
    expect(out.length).toBeLessThan(600);
    expect(out.endsWith('(잘림)')).toBe(true);
  });
});

/**
 * 확장자는 클라이언트가 준 URL 에서 온다 — 널바이트가 섞이면 createWriteStream 이 동기로 던지고,
 * 역슬래시가 섞이면 윈도우에서 tmpdir 밖 경로가 된다. 영숫자만 통과시킨다.
 */
describe('resolveDownloadExtension — 확장자 화이트리스트', () => {
  it.each([
    ['private/5/a-x.pdf', 'pdf'],
    ['private/5/a-x.XLSX', 'XLSX'],
    ['private/5/a-x', 'bin'],
    ['private/5/a-x.', 'bin'],
  ])('%s → %s', (key, expected) => {
    expect(resolveDownloadExtension(key)).toBe(expected);
  });

  it('★널바이트가 섞인 확장자는 bin 으로 떨어뜨린다', () => {
    expect(resolveDownloadExtension('private/5/a-x.p\u0000ng')).toBe('bin');
  });

  // ★ 역슬래시는 문자 코드로 박는다. 문자열 리터럴에 적으면 이스케이프가 한 번 풀려 개행이 들어가고,
  //   그러면 바로 위 널바이트 케이스와 '같은 것' 을 두 번 보게 된다(실제로 그랬다 — 리뷰가 잡았다).
  const BACKSLASH = String.fromCharCode(92);

  it('★역슬래시가 섞인 확장자는 bin 으로 떨어뜨린다 (윈도우에서 tmpdir 밖 경로가 된다)', () => {
    expect(resolveDownloadExtension(`private/5/a-x.p${BACKSLASH}ng`)).toBe('bin');
  });

  it('비정상적으로 긴 확장자도 bin', () => {
    expect(resolveDownloadExtension(`private/5/a-x.${'a'.repeat(50)}`)).toBe('bin');
  });
});
