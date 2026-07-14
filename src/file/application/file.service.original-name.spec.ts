import { FileService } from './file.service';

/**
 * 다운로드 프록시가 쓰는 원본 파일명 복원 회귀 테스트.
 * DB에 파일명 컬럼이 없는 도메인(주문접수)은 S3 key 의 `{무작위식별자}-{원본명}` 에서
 * 첫 '-' 뒤를 원본명으로 복원한다. 신키(private/uuid)·구키(file/Date.now) 모두 호환되어야 한다.
 */
describe('FileService.extractOriginalFileName — key 에서 원본명 복원', () => {
  const sut = new FileService({} as any);

  it('신키(private/{32hex}-원본) → 원본명', () => {
    const url = 'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-보고서.xlsx';
    expect(sut.extractOriginalFileName(url)).toBe('보고서.xlsx');
  });

  it('구키(file/{Date.now}-원본) → 원본명 (레거시 호환)', () => {
    const url = 'https://b.s3.amazonaws.com/file/1780551879605-주문서.xlsx';
    expect(sut.extractOriginalFileName(url)).toBe('주문서.xlsx');
  });

  it('원본명에 하이픈이 있어도 보존', () => {
    const url = 'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-2024-01-주문.xlsx';
    expect(sut.extractOriginalFileName(url)).toBe('2024-01-주문.xlsx');
  });

  it('URL 인코딩된 한글 파일명 디코드', () => {
    const url =
      'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-' + encodeURIComponent('정산내역.xlsx');
    expect(sut.extractOriginalFileName(url)).toBe('정산내역.xlsx');
  });
});
