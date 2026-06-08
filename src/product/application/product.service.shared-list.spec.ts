import { ProductService } from './product.service';

/**
 * 공유 상품리스트 업로드가 비공개 저장(uploadPrivateFile)을 쓰는지 회귀 테스트.
 *
 * 보안 결함: 공유리스트가 generic uploadFile()(public-read)로 저장돼 직접 객체 접근 표면 존재.
 * 수정: uploadSharedListFile 이 uploadPrivateFile() 를 호출하도록 교체.
 *
 * 생성자 의존성이 많아 Object.create 로 우회 후 협력자만 mock 주입.
 */
describe('ProductService.uploadSharedListFile — 비공개 저장 사용', () => {
  const user = { id: 9 } as any;
  const file = { originalname: 'list.xlsx', buffer: Buffer.from('x') } as any;
  const uploaded = { url: 'https://b.s3.amazonaws.com/private/uuid-list.xlsx', originalName: 'list.xlsx' };

  const makeSut = () => {
    const sut: any = Object.create(ProductService.prototype);
    sut.fileStorage = {
      uploadPrivateFile: jest.fn().mockResolvedValue(uploaded),
      uploadFile: jest.fn().mockResolvedValue(uploaded), // 호출되면 안 됨(검증용)
    };
    sut.productSharedListFileRepository = {
      save: jest.fn().mockResolvedValue({
        id: 1,
        fileName: 'list.xlsx',
        userId: 9,
        fileUrl: uploaded.url,
        createdAt: new Date(0),
      }),
    };
    return sut;
  };

  it('공유리스트는 uploadPrivateFile 로 저장하고 공개 uploadFile 은 쓰지 않는다', async () => {
    const sut = makeSut();

    await sut.uploadSharedListFile(user, file);

    expect(sut.fileStorage.uploadPrivateFile).toHaveBeenCalledTimes(1);
    expect(sut.fileStorage.uploadFile).not.toHaveBeenCalled();
    // 비공개 저장에서 받은 url 을 DB 에 보존(다운로드 시 백엔드가 key 로 GetObject)
    expect(sut.productSharedListFileRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 9, fileName: 'list.xlsx', fileUrl: uploaded.url }),
    );
  });

  it('엑셀/CSV 가 아니면 거부(업로드 시도 안 함)', async () => {
    const sut = makeSut();

    await expect(
      sut.uploadSharedListFile(user, { originalname: 'a.txt', buffer: Buffer.from('x') } as any),
    ).rejects.toThrow('엑셀 또는 CSV');
    expect(sut.fileStorage.uploadPrivateFile).not.toHaveBeenCalled();
  });
});
