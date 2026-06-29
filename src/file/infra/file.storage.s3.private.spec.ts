import { FileStorageS3 } from './file.storage.s3';

/**
 * 공유리스트 등 비공개 저장(uploadPrivateFile) 회귀 테스트.
 *
 * 보안 결함: 공유 상품리스트 원본이 generic uploadFile() 로 ACL: public-read +
 *   `file/${Date.now()}-${원본명}` key 로 저장돼, 키 추측/유출 시 인증 없이 직접 접근 가능.
 * 수정: uploadPrivateFile() 추가 — ACL: private + `private/${uuid}-...` 무작위 key.
 *   (다운로드는 백엔드가 자격증명으로 GetObject 하므로 public-read 불필요)
 *
 * 생성자(자격증명 필요) 우회를 위해 Object.create 로 인스턴스화 후 협력자만 mock.
 */
describe('FileStorageS3.uploadPrivateFile — 비공개 저장', () => {
  const makeSut = () => {
    const sut: any = Object.create(FileStorageS3.prototype);
    sut.configService = { getOrThrow: jest.fn().mockReturnValue('my-bucket') };
    sut.s3Client = { send: jest.fn().mockResolvedValue({}) };
    return sut;
  };
  const file = { originalname: 'list.xlsx', buffer: Buffer.from('x') } as any;

  const sentInput = (sut: any) => sut.s3Client.send.mock.calls[0][0].input;

  it('ACL 은 private, key 는 private/ 무작위(UUID) — 추측 차단', async () => {
    const sut = makeSut();

    await sut.uploadPrivateFile(file);

    const input = sentInput(sut);
    expect(input.ACL).toBe('private');
    expect(input.Key).toMatch(/^private\//);
    expect(input.Key).not.toMatch(/^file\//);
    // 무작위 UUID(하이픈 제거 32 hex) 포함 → "업로드 시각 + 파일명" 추측 불가.
    // 하이픈을 제거하는 이유: 다운로드 프록시가 key 를 `{식별자}-{원본명}` 으로 보고 첫 '-' 기준
    // 원본명을 복원하므로 식별자에 '-' 가 있으면 안 된다.
    expect(input.Key).toMatch(/^private\/[0-9a-f]{32}-/);
  });

  it('반환 url 은 저장 key 기반(백엔드 GetObject 용), originalName 보존', async () => {
    const sut = makeSut();

    const res = await sut.uploadPrivateFile(file);

    expect(res.originalName).toBe('list.xlsx');
    expect(res.url).toContain('my-bucket.s3.amazonaws.com/private/');
  });

  it('회귀: 기존 uploadFile 은 그대로 public-read + file/ key (다른 호출처 영향 없음)', async () => {
    const sut = makeSut();

    await sut.uploadFile(file);

    const input = sentInput(sut);
    expect(input.ACL).toBe('public-read');
    expect(input.Key).toMatch(/^file\//);
  });
});
