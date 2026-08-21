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

/**
 * ★ 본문 stall — 리뷰에서 나온 결함의 회귀.
 *
 * pipeline 은 스트림이 '끝나는' 경로만 덮는다. 상대가 한 청크를 준 뒤 end 도 error 도 없이 멈추면
 * 그건 끝나는 경로가 아니라서 안 덮이고, Promise 가 영영 settle 되지 않는다.
 * 클라이언트 옵션(socketTimeout)으로는 못 막는다 — SDK 가 응답 헤더 도착 시 그 예약을 지운다.
 * 그래서 우리가 '쓴 바이트 수' 로 직접 잰다. 이 스펙이 그 방어가 실제로 동작하는지 본다
 * (설정이 전달됐는지가 아니라).
 */
describe('FileStorageS3.downloadFileToLocalWithPath — 본문 stall 감시', () => {
  let dir: string;
  let originalStallMs: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-stall-spec-'));
    originalStallMs = FileStorageS3.BODY_STALL_TIMEOUT_MS;
    (FileStorageS3 as any).BODY_STALL_TIMEOUT_MS = 50;
  });

  afterEach(() => {
    (FileStorageS3 as any).BODY_STALL_TIMEOUT_MS = originalStallMs;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeSut = (body: unknown) => {
    const sut: any = Object.create(FileStorageS3.prototype);
    sut.configService = { getOrThrow: jest.fn().mockReturnValue('my-bucket') };
    sut.s3Client = { send: jest.fn().mockResolvedValue({ Body: body }) };
    sut.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    return sut as FileStorageS3;
  };

  /** 한 청크만 주고 end 도 error 도 안 내는 스트림 — 상대가 멈춘 상황 그대로. */
  const stallingBody = () => {
    const body = new Readable({
      read() {
        /* 더 안 준다 */
      },
    });
    body.push(Buffer.from('first-chunk'));
    return body;
  };

  it('★한 청크 뒤 멈추면 매달리지 않고 reject 한다', async () => {
    const sut = makeSut(stallingBody());
    await expect(sut.downloadFileToLocalWithPath(dir, 'out', 'private/5/abcdef01-a.txt')).rejects.toThrow(
      /진행되지 않아/,
    );
  });

  it('★stall 로 끊긴 뒤 부분 파일을 남기지 않는다', async () => {
    const sut = makeSut(stallingBody());
    await expect(sut.downloadFileToLocalWithPath(dir, 'out', 'private/5/abcdef01-a.txt')).rejects.toBeInstanceOf(Error);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  // ★ 처음엔 setInterval(상한) 으로 "직전 tick 과 바이트가 같은가" 만 봤다. 그러면 tick 직후에 청크가
  //   하나 오고 멈출 때 다음 tick 이 '진행 있음' 으로 소비되고 그다음 tick 에서야 끊겨,
  //   마지막 진행으로부터 **최대 2배**까지 늦는다(리뷰 지적). 결과만 보는 단언으로는 안 잡힌다.
  // ★ 처음엔 setInterval(상한) 으로 "직전 tick 과 바이트가 같은가" 만 봤다. 그러면 tick 직후에 청크가
  //   오면 다음 tick 이 '진행 있음' 으로 소비되고 그다음 tick 에서야 끊겨, 마지막 진행으로부터
  //   **최대 2배**까지 늦는다(리뷰 지적). 결과만 보는 단언으로는 안 잡힌다 — '언제' 끊기는지를 고정한다.
  //
  //   상한 300ms 기준으로 tick 직후(310ms)에 두 번째 청크를 흘리면:
  //     고친 것 : 마지막 진행 + 300 → 약 320ms 뒤 종료
  // ★ 리뷰 요구 — "매 chunk마다 단발 timer를 clear/reset하고, 마지막 chunk 이후
  //   BODY_STALL_TIMEOUT_MS 경계에서 reject되는 fake-timer 회귀 테스트를 추가해 주세요."
  //
  //   실타이머로 '몇 ms 뒤에 끊겼나' 를 재는 방식은 부하가 걸린 CI 에서 흔들린다. 여기서는 시간을 직접
  //   밀어 **'청크가 오면 타이머가 다시 걸린다'** 를 결정적으로 고정한다.
  // ★ 리뷰 요구 — "매 chunk마다 단발 timer를 clear/reset하고, 마지막 chunk 이후
  //   BODY_STALL_TIMEOUT_MS 경계에서 reject되는 fake-timer 회귀 테스트를 추가해 주세요."
  //
  //   ⚠️ fake timer 로 이 경로를 재려고 했으나 **뮤테이션을 못 잡았다**(arm 이 리셋을 안 하게 바꿔도 초록).
  //   Body.destroy 뒤 pipeline 정리가 실제 fs I/O 를 거쳐서, 시간을 밀어도 rejection 이 그 시점에
  //   관측되지 않는다(setImmediate 20회를 흘려도 같았다). 그래서 여기서는 **실제로 걸리는 방식**으로 잰다:
  //     · 아래 실시간 경계 테스트 — '언제' 끊기는지를 재고, 되돌리면 실제로 빨개진다
  //     · 타이머 자체의 리셋 의미는 file.storage.s3.stall-watch.spec.ts 가 fake timer 로 결정적으로 고정
  //
  //   상한 300ms 기준으로 tick 직후(310ms)에 두 번째 청크를 흘리면:
  //     리셋 있음 : 마지막 진행 + 300 → 약 320ms 뒤 종료
  //     리셋 없음 : 최초 arm 에서 300ms 뒤 이미 종료됐거나, 옛 interval 방식이면 약 590ms 뒤
  it('★마지막 청크 이후 상한 근처에서 끊는다 — 리셋이 실제로 걸린다', async () => {
    (FileStorageS3 as any).BODY_STALL_TIMEOUT_MS = 300;
    const body = new Readable({ read() {} });
    body.push(Buffer.from('first'));
    const sut = makeSut(body);
    const pending = expect(sut.downloadFileToLocalWithPath(dir, 'out', 'private/5/abcdef01-a.txt')).rejects.toThrow(
      /진행되지 않아/,
    );

    await new Promise((r) => setTimeout(r, 200));
    body.push(Buffer.from('late-chunk'));
    const pushedAt = Date.now();
    await pending;
    const sinceLastChunk = Date.now() - pushedAt;

    // 리셋이 안 걸리면 최초 arm 기준이라 여기서 100ms 안에 끊긴다.
    expect(sinceLastChunk).toBeGreaterThanOrEqual(250);
    expect(sinceLastChunk).toBeLessThan(500);
  });

  it('★getFileBuffer 도 같은 방어를 받는다 — 한쪽만 막으면 다른 쪽으로 샌다', async () => {
    const sut = makeSut(stallingBody());
    await expect(sut.getFileBuffer('private/5/abcdef01-a.xlsx')).rejects.toThrow(/진행되지 않아/);
  });

  it('getFileBuffer 정상 본문은 그대로 버퍼로 돌려준다', async () => {
    const sut = makeSut(Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    expect((await sut.getFileBuffer('private/5/abcdef01-a.xlsx')).toString()).toBe('abcd');
  });

  it('정상적으로 끝나는 본문은 stall 로 오인하지 않는다', async () => {
    const body = Readable.from([Buffer.from('hello')]);
    const sut = makeSut(body);
    const out = await sut.downloadFileToLocalWithPath(dir, 'out', 'private/5/abcdef01-a.txt');
    expect(fs.readFileSync(out, 'utf8')).toBe('hello');
  });
});
