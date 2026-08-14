import { BadRequestException, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { FileService } from './file.service';

/**
 * downloadWithPath 오류 처리 회귀:
 *  - URL 형식 아님 → BadRequest
 *  - S3 객체 없음(NoSuchKey / 404) → NotFound
 *  - 그 외 S3 실패(인증/네트워크 등) → InternalServerError (원인은 로그로 보존, "경로 오류"로 오도하지 않음)
 *  - 성공 → 로컬 파일 경로 반환
 * ※ 과거 구현은 await 누락으로 S3 비동기 실패가 catch 를 우회했다 → 이 스펙이 그 회귀를 잠근다.
 */
describe('FileService.downloadWithPath — 오류 처리', () => {
  const validUrl = 'https://b.s3.amazonaws.com/private/5/0123456789abcdef-a.xlsx';

  const makeSut = (downloadImpl: jest.Mock) => {
    const storage: any = { downloadFileToLocalWithPath: downloadImpl };
    return new FileService(storage);
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); // 로그 노이즈 억제
  });
  afterEach(() => jest.restoreAllMocks());

  it('성공 → 로컬 경로 반환 (실제 await)', async () => {
    const sut = makeSut(jest.fn().mockResolvedValue('/tmp/out.xlsx'));
    await expect(sut.downloadWithPath('/tmp', 'name', validUrl)).resolves.toBe('/tmp/out.xlsx');
  });

  it('URL 형식이 아니면 → BadRequest, S3 호출 안 함', async () => {
    const download = jest.fn();
    const sut = makeSut(download);
    await expect(sut.downloadWithPath('/tmp', 'name', 'not-a-url')).rejects.toBeInstanceOf(BadRequestException);
    expect(download).not.toHaveBeenCalled();
  });

  it('S3 NoSuchKey → NotFound (await 로 실제 포착)', async () => {
    const sut = makeSut(jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { name: 'NoSuchKey' })));
    await expect(sut.downloadWithPath('/tmp', 'name', validUrl)).rejects.toBeInstanceOf(NotFoundException);
  });

  // ★ 코드가 없을 때만 404 를 '객체 없음' 으로 본다. 코드가 있으면 코드로만 판정한다(아래 NoSuchBucket 참조).
  it('S3 $metadata 404 (에러 코드 없음) → NotFound', async () => {
    const sut = makeSut(jest.fn().mockRejectedValue({ $metadata: { httpStatusCode: 404 } }));
    await expect(sut.downloadWithPath('/tmp', 'name', validUrl)).rejects.toBeInstanceOf(NotFoundException);
  });

  // ★ NoSuchBucket 도 HTTP 404 다. 404 만 보고 '파일 없음' 으로 번역하면 버킷 설정이 깨진 인프라 장애가
  //   사용자에게 "파일을 찾을 수 없습니다" 로 나가고, 500 이면 울릴 경보가 4xx 라 울리지 않는다.
  it('★NoSuchBucket(404) → InternalServerError (인프라 장애를 파일 없음으로 위장하지 않는다)', async () => {
    const sut = makeSut(
      jest.fn().mockRejectedValue(
        Object.assign(new Error('no bucket'), {
          name: 'NoSuchBucket',
          $metadata: { httpStatusCode: 404 },
        }),
      ),
    );
    await expect(
      sut.downloadWithPath('/tmp', 't', 'https://b.s3.amazonaws.com/private/5/a.xlsx'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('HeadObject 계열 NotFound(404) → NotFound', async () => {
    const sut = makeSut(
      jest.fn().mockRejectedValue(
        Object.assign(new Error('nf'), {
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        }),
      ),
    );
    await expect(
      sut.downloadWithPath('/tmp', 't', 'https://b.s3.amazonaws.com/private/5/a.xlsx'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('그 외 S3 실패(인증/네트워크) → InternalServerError (경로오류로 오도 안 함)', async () => {
    const sut = makeSut(
      jest.fn().mockRejectedValue(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' })),
    );
    await expect(sut.downloadWithPath('/tmp', 'name', validUrl)).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('S3 실패 시 원인을 로그로 남긴다(폐기하지 않음)', async () => {
    const err = Object.assign(new Error('boom'), { name: 'TimeoutError' });
    const sut = makeSut(jest.fn().mockRejectedValue(err));
    await expect(sut.downloadWithPath('/tmp', 'name', validUrl)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});
