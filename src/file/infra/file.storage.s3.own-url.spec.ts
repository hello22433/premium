import { FileStorageS3 } from './file.storage.s3';

/**
 * isOwnStorageUrl 의 실동작 회귀.
 *
 * ★ 리뷰 지적 — "리포지토리 전체에 실동작 테스트가 0건입니다(전부 mockReturnValue(true) 목).
 *   외부 host 차단이라는 실제 방어선이 한 번도 검증되지 않습니다."
 *   호출부 테스트는 목을 false 로 바꿔 '차단하면 어떻게 되나' 만 본다. 무엇을 차단하는지는 여기서만 본다.
 *
 * ★ 예전 구현(startsWith + endsWith)은 가운데에 무엇이 끼어도 통과했다. S3 버킷 이름에는 점을 쓸 수
 *   있으므로 남이 `{우리버킷}.s3.evil` 버킷을 만들면 통과한다 — 아래 케이스가 그것이다.
 */
describe('FileStorageS3.isOwnStorageUrl', () => {
  const BUCKET = 'epopkon-premium';
  const sut = new FileStorageS3({ getOrThrow: jest.fn().mockReturnValue(BUCKET) } as any);
  const check = (host: string) => sut.isOwnStorageUrl(`https://${host}/private/5/abcdef01-a.pdf`);

  it.each([
    [`${BUCKET}.s3.amazonaws.com`, '업로드가 실제로 만드는 형식'],
    [`${BUCKET}.s3.ap-northeast-2.amazonaws.com`, '리전 포함 변형'],
  ])('허용: %s (%s)', (host) => {
    expect(check(host)).toBe(true);
  });

  it.each([
    ['evil.com', '완전 외부'],
    [`${BUCKET}.s3.amazonaws.com.evil.com`, '접미 위장'],
    [`not-${BUCKET}.s3.amazonaws.com`, '접두 위장'],
    [`${BUCKET}x.s3.amazonaws.com`, '버킷명 뒤에 덧붙임'],
    [`s3.amazonaws.com`, '버킷 없음'],
  ])('차단: %s (%s)', (host) => {
    expect(check(host)).toBe(false);
  });

  // ★ 이 한 줄이 이 수정의 이유다. 예전 구현에서는 통과했다(실측).
  it('★차단: 남이 만든 버킷 `{우리버킷}.s3.evil` — 가운데 끼워넣기', () => {
    expect(check(`${BUCKET}.s3.evil.s3.amazonaws.com`)).toBe(false);
  });

  it('★차단: 리전 자리에 점을 넣어 도메인을 늘리는 형태', () => {
    expect(check(`${BUCKET}.s3.a.b.amazonaws.com`)).toBe(false);
  });

  it('URL 이 아니면 false (던지지 않는다)', () => {
    expect(sut.isOwnStorageUrl('not-a-url')).toBe(false);
    expect(sut.isOwnStorageUrl('')).toBe(false);
  });

  it('버킷 이름에 정규식 특수문자가 있어도 문자 그대로 본다', () => {
    const dotted = new FileStorageS3({ getOrThrow: jest.fn().mockReturnValue('a.b') } as any);
    expect(dotted.isOwnStorageUrl('https://a.b.s3.amazonaws.com/x')).toBe(true);
    expect(dotted.isOwnStorageUrl('https://aXb.s3.amazonaws.com/x')).toBe(false);
  });
});
