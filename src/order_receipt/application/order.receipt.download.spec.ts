import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderReceiptService } from './order.receipt.service';
import { IUserAuthority } from '../../user/interface/user.authority';

/**
 * 주문접수 첨부 다운로드 프록시 회귀 — 문서권한 / 첨부귀속 / 객체소유(우회 차단) / 원본명.
 *  - 문서권한: 운영/최고관리자=전체, 기업관리자=본인 문서만.
 *  - 객체소유: filePath 는 클라이언트가 임의 지정 가능하므로, key 의 private/{ownerId}/ 소유자가
 *    요청자(or 관리자)인지까지 검증해야 타인 private 객체 우회 read 를 막는다. (PR #538 HIGH)
 */
describe('OrderReceiptService.downloadFile', () => {
  // 신 key 포맷: private/{ownerId}/{uuid}-{name}
  const ownUrl = 'https://b.s3.amazonaws.com/private/10/0123456789abcdef0123456789abcdef-보고서.xlsx';
  // 타인(ownerId=11) 의 private 객체 — 공격자가 자기 filePath 에 심어도 받으면 안 됨
  const foreignUrl = 'https://b.s3.amazonaws.com/private/11/ffffffffffffffffffffffffffffffff-남의것.xlsx';

  const makeSut = (filePath: string) => {
    const repo: any = { findOne: jest.fn().mockResolvedValue({ id: 1, userId: 10, filePath }) };
    const fileService: any = {
      extractStorageKey: (url: string) => new URL(url).pathname.replace(/^\/+/, ''),
      getOriginalName: jest.fn().mockResolvedValue('보고서.xlsx'),
      downloadWithPath: jest.fn().mockResolvedValue('/tmp/x.xlsx'),
    };
    return { sut: new OrderReceiptService(repo, fileService), fileService };
  };

  const owner = { id: 10, authority: IUserAuthority.CORPORATE_ADMIN } as any;
  const otherCorp = { id: 11, authority: IUserAuthority.CORPORATE_ADMIN } as any;
  const admin = { id: 99, authority: IUserAuthority.OPERATION_ADMIN } as any;

  it('본인 문서 + 본인 객체 → 원본명 + 임시경로 반환', async () => {
    const { sut, fileService } = makeSut(ownUrl);
    const r = await sut.downloadFile(owner, 1, ownUrl);
    expect(r).toEqual({ fileName: '보고서.xlsx', filePath: '/tmp/x.xlsx' });
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
  });

  it('관리자 → 타인 소유 객체도 허용', async () => {
    const { sut } = makeSut(ownUrl);
    await expect(sut.downloadFile(admin, 1, ownUrl)).resolves.toBeDefined();
  });

  it('타 기업관리자(문서 비소유) → Forbidden', async () => {
    const { sut, fileService } = makeSut(ownUrl);
    await expect(sut.downloadFile(otherCorp, 1, ownUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('첨부에 없는 url → BadRequest, 다운로드 시도 안 함', async () => {
    const { sut, fileService } = makeSut(ownUrl);
    const notAttached = 'https://b.s3.amazonaws.com/private/10/aaaa-다른것.xlsx';
    await expect(sut.downloadFile(owner, 1, notAttached)).rejects.toBeInstanceOf(BadRequestException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★우회 차단: 본인 filePath 에 타인 private key 를 심어도 → Forbidden (PR#538 HIGH)', async () => {
    // foreignUrl 이 owner 의 filePath 에 들어있어 includes() 는 통과하지만, key 소유자(11)≠요청자(10)
    const { sut, fileService } = makeSut(foreignUrl);
    await expect(sut.downloadFile(owner, 1, foreignUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★우회 차단: ownerId 세그먼트 없는 구 private key(공유리스트 등) → Forbidden', async () => {
    const legacyPrivate = 'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-list.xlsx';
    const { sut, fileService } = makeSut(legacyPrivate);
    await expect(sut.downloadFile(owner, 1, legacyPrivate)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('레거시 공개 첨부(file/) 는 호환 허용 (이미 공개 객체)', async () => {
    const legacyPublic = 'https://b.s3.amazonaws.com/file/1780551879605-주문서.xlsx';
    const { sut, fileService } = makeSut(legacyPublic);
    await expect(sut.downloadFile(owner, 1, legacyPublic)).resolves.toBeDefined();
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
  });
});
