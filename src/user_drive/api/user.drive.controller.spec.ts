import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UserDriveController } from './user.drive.controller';

/**
 * 첨부 다운로드 스트리밍의 경계를 고정한다.
 *
 * ★ 왜 컨트롤러 레벨이 필요한가 — 서비스 스펙은 "무엇을 돌려주나" 까지만 본다. 헤더를 언제 거는지,
 *   임시파일이 지워지는지, 실패가 어떤 모양으로 나가는지는 여기서만 보인다.
 *
 * ★ 특히 fs.createReadStream 은 파일을 동기로 열지 않는다. 예전엔 try/catch 로만 감싸서
 *   비동기 open 실패(EMFILE·EACCES·ENOENT)는 못 잡았고, 그때는 이미 attachment 헤더를 건 뒤라
 *   pipeline 이 res 를 destroy → 클라이언트는 500 JSON 이 아니라 ECONNRESET 을 받았다.
 */
describe('UserDriveController.downloadFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-drive-controller-spec-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const user = { id: 10, authority: 'OPERATION_ADMIN' } as any;

  const makeRes = () => {
    const res: any = new PassThrough();
    res.setHeader = jest.fn();
    res.removeHeader = jest.fn();
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn();
    return res;
  };

  const makeSut = (fileName: string, filePath: string) => {
    const service: any = { downloadFile: jest.fn().mockResolvedValue({ fileName, filePath }) };
    const sut = new UserDriveController(service);
    const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    (sut as any).logger = logger;
    return { sut, logger };
  };

  const waitUntilGone = async (target: string) => {
    for (let i = 0; i < 50; i += 1) {
      if (!fs.existsSync(target)) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  it('정상: 헤더를 걸고 내용을 흘려보낸 뒤 임시파일을 지운다', async () => {
    const filePath = path.join(dir, 'tmp.bin');
    fs.writeFileSync(filePath, 'hello');
    const { sut } = makeSut('보고서.pdf', filePath);
    const res = makeRes();

    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    const ended = new Promise((resolve) => res.once('end', resolve));

    await sut.downloadFile(user, { id: 1 } as any, { fileUrl: 'https://b/x' } as any, res);
    await ended;

    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Expose-Headers', 'Content-Disposition');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('attachment;'));
    expect(await waitUntilGone(filePath)).toBe(true);
  });

  it('★파일 open 이 비동기로 실패하면 헤더를 하나도 걸지 않고 예외로 나간다', async () => {
    const missing = path.join(dir, 'not-there.bin');
    const { sut } = makeSut('보고서.pdf', missing);
    const res = makeRes();

    await expect(
      sut.downloadFile(user, { id: 1 } as any, { fileUrl: 'https://b/x' } as any, res),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // 헤더가 붙지 않아야 ExceptionFilter 가 만든 500 JSON 이 첨부로 저장되지 않는다.
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('★open 실패 경로에서도 임시파일 정리를 시도한다', async () => {
    const filePath = path.join(dir, 'locked.bin');
    fs.writeFileSync(filePath, 'x');
    const { sut } = makeSut('보고서.pdf', filePath);
    const res = makeRes();

    // open 자체를 실패시킨다 — 비동기 실패 경로를 그대로 태운다.
    const spy = jest.spyOn(fs, 'createReadStream').mockImplementation(() => {
      const stream: any = new PassThrough();
      stream.destroy = jest.fn();
      process.nextTick(() => stream.emit('error', Object.assign(new Error('too many files'), { code: 'EMFILE' })));
      return stream;
    });

    try {
      await expect(
        sut.downloadFile(user, { id: 1 } as any, { fileUrl: 'https://b/x' } as any, res),
      ).rejects.toMatchObject({ code: 'EMFILE' });
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(await waitUntilGone(filePath)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
