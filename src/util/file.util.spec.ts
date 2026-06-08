import { tmpdir } from 'node:os';
import { createExportTempPath } from './file.util';

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
