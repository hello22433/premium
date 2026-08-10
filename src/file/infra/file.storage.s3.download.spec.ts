import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'stream';
import { FileStorageS3 } from './file.storage.s3';

/**
 * downloadFileToLocalWithPath 의 스트림 종료 계약을 고정한다.
 *
 * 과거 구현은 `Body.pipe(writeStream)` 뒤 writeStream 의 finish/error 만 들었다. 그러면 S3 Body 가
 * 전송 도중 끊길 때(네트워크 리셋 등) 소스 오류를 아무도 처리하지 않아
 *   ① Promise 가 영영 settle 되지 않아 요청이 매달리고(임시파일도 영구 잔존)
 *   ② 소스 오류가 uncaughtException 으로 튀어 프로세스가 죽을 수 있었다.
 * FileService.downloadWithPath 에 await 를 넣어도 이 오류는 그 Promise 로 오지 않아 소용이 없다.
 *
 * 그래서 목이 아니라 실제 파일시스템/스트림으로 검증한다 — 목으로는 위 두 증상이 재현되지 않는다.
 * 회귀 시 이 스펙은 "reject 안 됨"으로 타임아웃 실패한다(=매달림을 그대로 드러낸다).
 */
describe('FileStorageS3.downloadFileToLocalWithPath — 스트림 종료 계약', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-download-spec-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Body 를 주입해 GetObject 응답을 흉내낸다. 생성자(자격증명 필요) 우회는 private.spec 과 동일 관례. */
  const makeSut = (body: unknown) => {
    const sut: any = Object.create(FileStorageS3.prototype);
    sut.configService = { getOrThrow: jest.fn().mockReturnValue('my-bucket') };
    sut.s3Client = { send: jest.fn().mockResolvedValue({ Body: body }) };
    sut.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    return sut;
  };

  const okBody = (chunks: string[]) => Readable.from(chunks.map((c) => Buffer.from(c)));

  /** 첫 청크를 흘린 뒤 전송 도중 끊기는 소스 — S3 커넥션 리셋 상황. */
  const brokenBody = (firstChunk: string, message: string) => {
    const body = new Readable({ read() {} });
    setImmediate(() => body.push(Buffer.from(firstChunk)));
    setImmediate(() => body.destroy(new Error(message)));
    return body;
  };

  it('정상 전송이면 로컬 경로를 돌려주고 내용이 보존된다', async () => {
    const sut = makeSut(okBody(['안녕', '하세요']));

    const result = await sut.downloadFileToLocalWithPath(dir, 'doc', 'private/5/uuid-보고서.pdf');

    expect(result).toBe(path.join(dir, 'doc.pdf'));
    expect(fs.readFileSync(result, 'utf8')).toBe('안녕하세요');
  });

  it('확장자 없는 key 는 .bin 으로 떨어진다 (경로 전체가 확장자가 되어 ENOENT 나던 회귀)', async () => {
    const sut = makeSut(okBody(['x']));

    const result = await sut.downloadFileToLocalWithPath(dir, 'doc', 'private/5/uuid-README');

    expect(result).toBe(path.join(dir, 'doc.bin'));
    expect(fs.existsSync(result)).toBe(true);
  });

  // ★ 핵심 회귀: 소스 오류가 반드시 이 Promise 로 전달되어야 한다.
  //   전달되지 않으면 호출자(FileService.downloadWithPath)의 try/catch 가 무용지물이고 요청이 매달린다.
  it('Body 가 전송 도중 끊기면 reject 한다 — 매달리지 않는다', async () => {
    const sut = makeSut(brokenBody('첫 청크', 'S3 전송 중 끊김'));

    await expect(sut.downloadFileToLocalWithPath(dir, 'doc', 'private/5/uuid-보고서.pdf')).rejects.toThrow(
      'S3 전송 중 끊김',
    );
  }, 5000);

  // ★ 실패했는데 부분 파일이 남으면 tmpdir 에 무기한 쌓인다. 실패 시 호출자는 경로를 못 받으므로
  //   (컨트롤러의 정리는 성공 경로에만 걸린다) 정리 책임이 이 메서드에 있다.
  it('Body 오류로 실패하면 이미 쓰인 부분 파일을 남기지 않는다', async () => {
    const sut = makeSut(brokenBody('부분 데이터', 'S3 전송 중 끊김'));

    await expect(sut.downloadFileToLocalWithPath(dir, 'doc', 'private/5/uuid-보고서.pdf')).rejects.toThrow();

    expect(fs.readdirSync(dir)).toEqual([]);
  }, 5000);

  it('대상 경로를 열 수 없으면(없는 디렉토리) reject 한다', async () => {
    const sut = makeSut(okBody(['x']));

    await expect(
      sut.downloadFileToLocalWithPath(path.join(dir, '존재하지-않는-폴더'), 'doc', 'private/5/uuid-a.pdf'),
    ).rejects.toThrow();
  }, 5000);

  it('Body 가 스트림이 아니면 명시적으로 던진다', async () => {
    const sut = makeSut(undefined);

    await expect(sut.downloadFileToLocalWithPath(dir, 'doc', 'private/5/uuid-a.pdf')).rejects.toThrow(
      'Body is not a readable stream',
    );
  });
});
