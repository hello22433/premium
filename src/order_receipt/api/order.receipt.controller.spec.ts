import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { OrderReceiptController } from './order.receipt.controller';

/**
 * 첨부 다운로드 스트리밍의 경계를 고정한다.
 *
 * ★ fs.createReadStream 은 파일을 동기로 열지 않는다. 예전엔 open 을 안 기다리고 헤더부터 걸어서,
 *   비동기 open 실패(EMFILE·EACCES·ENOENT)면 이미 attachment 헤더가 붙은 뒤 pipeline 이 res 를
 *   destroy 했다 → 클라이언트는 500 JSON 이 아니라 ECONNRESET 을 받았다.
 *   문서함 컨트롤러가 리뷰 지적으로 먼저 고쳤고, 같은 구조인 이 형제도 맞췄다.
 */
describe('OrderReceiptController.downloadFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-receipt-controller-spec-'));
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
    const authService: any = { authorityValidator: jest.fn().mockResolvedValue(undefined) };
    const sut = new OrderReceiptController(service, authService);
    (sut as any).logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    return sut;
  };

  const waitUntilGone = async (target: string) => {
    for (let i = 0; i < 50; i += 1) {
      if (!fs.existsSync(target)) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  const call = (sut: OrderReceiptController, res: any) =>
    sut.downloadFile(user, { id: 1 } as any, { fileUrl: 'https://b/x' } as any, res);

  it('정상: 헤더를 걸고 내용을 흘려보낸 뒤 임시파일을 지운다', async () => {
    const filePath = path.join(dir, 'tmp.bin');
    fs.writeFileSync(filePath, 'hello');
    const sut = makeSut('보고서.pdf', filePath);
    const res = makeRes();

    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    const ended = new Promise((resolve) => res.once('end', resolve));

    await call(sut, res);
    await ended;

    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('attachment;'));
    expect(await waitUntilGone(filePath)).toBe(true);
  });

  it('★파일 open 이 비동기로 실패하면 헤더를 하나도 걸지 않고 예외로 나간다', async () => {
    const sut = makeSut('보고서.pdf', path.join(dir, 'not-there.bin'));
    const res = makeRes();

    await expect(call(sut, res)).rejects.toMatchObject({ code: 'ENOENT' });
    // 헤더가 붙지 않아야 ExceptionFilter 가 만든 500 JSON 이 첨부로 저장되지 않는다.
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('★open 실패 경로에서도 임시파일 정리를 시도한다', async () => {
    const filePath = path.join(dir, 'locked.bin');
    fs.writeFileSync(filePath, 'x');
    const sut = makeSut('보고서.pdf', filePath);
    const res = makeRes();

    const spy = jest.spyOn(fs, 'createReadStream').mockImplementation(() => {
      const stream: any = new PassThrough();
      stream.destroy = jest.fn();
      process.nextTick(() => stream.emit('error', Object.assign(new Error('too many files'), { code: 'EMFILE' })));
      return stream;
    });

    try {
      await expect(call(sut, res)).rejects.toMatchObject({ code: 'EMFILE' });
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(await waitUntilGone(filePath)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
