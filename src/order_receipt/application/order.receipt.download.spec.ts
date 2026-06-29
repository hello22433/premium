import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderReceiptService } from './order.receipt.service';
import { IUserAuthority } from '../../user/interface/user.authority';

/**
 * 주문접수 첨부 다운로드 프록시 회귀 — 권한/IDOR/원본명.
 *  - 권한: 운영/최고관리자=전체, 기업관리자=본인 문서만.
 *  - IDOR: 요청 fileUrl 이 해당 문서 filePath 에 없으면 거부(다운로드 시도조차 안 함).
 */
describe('OrderReceiptService.downloadFile', () => {
  const url = 'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-보고서.xlsx';
  const receipt = { id: 1, userId: 10, filePath: url } as any;

  const makeSut = () => {
    const repo: any = { findOne: jest.fn().mockResolvedValue(receipt) };
    const fileService: any = {
      extractOriginalFileName: jest.fn().mockReturnValue('보고서.xlsx'),
      downloadWithPath: jest.fn().mockResolvedValue('/tmp/x.xlsx'),
    };
    return { sut: new OrderReceiptService(repo, fileService), fileService };
  };

  const owner = { id: 10, authority: IUserAuthority.CORPORATE_ADMIN } as any;
  const otherCorp = { id: 11, authority: IUserAuthority.CORPORATE_ADMIN } as any;
  const admin = { id: 99, authority: IUserAuthority.OPERATION_ADMIN } as any;

  it('본인 문서 → 원본명 + 임시경로 반환', async () => {
    const { sut, fileService } = makeSut();
    const r = await sut.downloadFile(owner, 1, url);
    expect(r).toEqual({ fileName: '보고서.xlsx', filePath: '/tmp/x.xlsx' });
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
  });

  it('관리자 → 타인 문서도 허용', async () => {
    const { sut } = makeSut();
    await expect(sut.downloadFile(admin, 1, url)).resolves.toBeDefined();
  });

  it('타 기업관리자(비소유) → Forbidden', async () => {
    const { sut, fileService } = makeSut();
    await expect(sut.downloadFile(otherCorp, 1, url)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('IDOR: 첨부에 없는 url → BadRequest, 다운로드 시도 안 함', async () => {
    const { sut, fileService } = makeSut();
    const foreign = 'https://b.s3.amazonaws.com/private/ffffffffffffffffffffffffffffffff-남의것.xlsx';
    await expect(sut.downloadFile(owner, 1, foreign)).rejects.toBeInstanceOf(BadRequestException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });
});
