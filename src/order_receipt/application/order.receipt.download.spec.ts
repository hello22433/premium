import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderReceiptService } from './order.receipt.service';
import { IUserAuthority } from '../../user/interface/user.authority';

/**
 * 주문접수 첨부 다운로드 프록시 회귀 — 문서권한(180일 포함) / 첨부귀속 / 객체소유(우회 차단) / 원본명.
 *  - 문서권한: 상세조회와 동일(assertCanReadReceipt) — 관리자 전체, 기업=본인+180일 이내.
 *  - 객체소유: filePath 는 클라이언트가 임의 지정 가능하므로, 우리 버킷 host + key 의
 *    private/{ownerId}/ 소유자가 요청자(or 관리자)인지까지 검증한다. (PR #538 리뷰)
 */
describe('OrderReceiptService.downloadFile', () => {
  // 신 key 포맷: private/{ownerId}/{uuid}-{name}
  const ownUrl = 'https://b.s3.amazonaws.com/private/10/0123456789abcdef0123456789abcdef-보고서.xlsx';
  // 타인(ownerId=11) 의 private 객체 — 공격자가 자기 filePath 에 심어도 받으면 안 됨
  const foreignUrl = 'https://b.s3.amazonaws.com/private/11/ffffffffffffffffffffffffffffffff-남의것.xlsx';

  const makeSut = (filePath: string, receiptOverrides: Record<string, any> = {}) => {
    const receipt = { id: 1, userId: 10, filePath, registerAt: new Date(), ...receiptOverrides };
    const repo: any = { findOne: jest.fn().mockResolvedValue(receipt) };
    const fileService: any = {
      extractStorageKey: (url: string) => new URL(url).pathname.replace(/^\/+/, ''),
      isOwnStorageUrl: jest.fn().mockReturnValue(true),
      getOriginalName: jest.fn().mockResolvedValue('보고서.xlsx'),
      downloadWithPath: jest.fn().mockResolvedValue('/tmp/x.xlsx'),
    };
    const autoOrderService: any = { run: jest.fn() };
    const userRepository: any = {};
    return { sut: new OrderReceiptService(repo, userRepository, fileService, autoOrderService), fileService };
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

  it('★180일: 기업관리자는 리스트 창(180일) 밖 본인 문서 첨부도 다운로드 불가', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 181);
    const { sut, fileService } = makeSut(ownUrl, { registerAt: oldDate });
    await expect(sut.downloadFile(owner, 1, ownUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('180일 밖이어도 관리자는 다운로드 가능', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 181);
    const { sut } = makeSut(ownUrl, { registerAt: oldDate });
    await expect(sut.downloadFile(admin, 1, ownUrl)).resolves.toBeDefined();
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

  it('★우회 차단: 우리 버킷 host 가 아닌 URL → Forbidden', async () => {
    const external = 'https://evil.example.com/private/10/abc-x.xlsx';
    const { sut, fileService } = makeSut(external);
    fileService.isOwnStorageUrl.mockReturnValue(false);
    await expect(sut.downloadFile(owner, 1, external)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★우회 차단: ownerId 세그먼트 없는 구 private key(공유리스트 등) → Forbidden', async () => {
    const legacyPrivate = 'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-list.xlsx';
    const { sut, fileService } = makeSut(legacyPrivate);
    await expect(sut.downloadFile(owner, 1, legacyPrivate)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★우회 차단: image/ 등 첨부 외 위치 → Forbidden (file/ 레거시만 허용)', async () => {
    const imageUrl = 'https://b.s3.amazonaws.com/image/abc-banner.png';
    const { sut, fileService } = makeSut(imageUrl);
    await expect(sut.downloadFile(owner, 1, imageUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('레거시 공개 첨부(file/) 는 호환 허용 (전환 전 주문접수 첨부)', async () => {
    const legacyPublic = 'https://b.s3.amazonaws.com/file/1780551879605-주문서.xlsx';
    const { sut, fileService } = makeSut(legacyPublic);
    await expect(sut.downloadFile(owner, 1, legacyPublic)).resolves.toBeDefined();
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
  });
});
