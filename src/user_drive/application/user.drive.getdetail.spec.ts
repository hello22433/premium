import { UserDriveService } from './user.drive.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserDriveStatus } from '../interface/user.drive.status';

/**
 * getDetail 의 files 조립 회귀:
 *  - url/name 짝맞춤 + 순서 보존
 *  - MAX_FILE_META_LOOKUP(=10) 경계: index<10 은 getOriginalName(HeadObject), index>=10 은 extractOriginalFileName(key 복원)
 *  - fail-soft: 한 항목의 이름 조회가 던져도 상세 전체가 500 나지 않고 마지막 경로조각으로 degrade
 */
describe('UserDriveService.getDetail — files 조립', () => {
  const admin = { id: 99, authority: IUserAuthority.OPERATION_ADMIN } as any; // 관리자 → receiveAt save 경로 회피

  const makeSut = (fileUrls: string[], fileServiceOverrides: Record<string, any> = {}) => {
    const drive = {
      id: 1,
      senderId: 5,
      receiverId: 10,
      status: IUserDriveStatus.REGISTER,
      sendAt: new Date('2026-01-01T00:00:00Z'),
      title: 't',
      content: 'c',
      replyContent: null,
      filePath: fileUrls.length ? fileUrls.join(',') : null,
      sender: { company: { businessName: 'BizCo' } },
      receiver: { personName: '홍길동', email: 'a@b.com', personPhoneNumber: '010-0000-0000' },
    };
    const driveRepo: any = { findOne: jest.fn().mockResolvedValue(drive), save: jest.fn() };
    const fileService: any = {
      getOriginalName: jest.fn(async (u: string) => `meta:${u.split('/').pop()}`),
      extractOriginalFileName: jest.fn((u: string) => `key:${u.split('/').pop()}`),
      ...fileServiceOverrides,
    };
    return { sut: new UserDriveService(driveRepo, {} as any, fileService), fileService };
  };

  it('url/name 짝을 순서대로 조립한다 (메타데이터 우선)', async () => {
    const urls = ['https://b/private/5/u1-a.xlsx', 'https://b/private/5/u2-b.xlsx'];
    const { sut, fileService } = makeSut(urls);

    const res = await sut.getDetail(admin, { id: 1 });

    expect(res.files).toEqual([
      { url: urls[0], name: 'meta:u1-a.xlsx' },
      { url: urls[1], name: 'meta:u2-b.xlsx' },
    ]);
    expect(res.filePathList).toEqual(urls); // 하위호환 필드 유지
    expect(fileService.getOriginalName).toHaveBeenCalledTimes(2);
    expect(fileService.extractOriginalFileName).not.toHaveBeenCalled();
  });

  it('첨부 11개: 앞 10개는 getOriginalName, 11번째는 extractOriginalFileName (경계)', async () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://b/private/5/u${i}-f${i}.xlsx`);
    const { sut, fileService } = makeSut(urls);

    const res = await sut.getDetail(admin, { id: 1 });

    expect(fileService.getOriginalName).toHaveBeenCalledTimes(10);
    expect(fileService.extractOriginalFileName).toHaveBeenCalledTimes(1);
    expect(res.files[9].name).toBe('meta:u9-f9.xlsx'); // index 9 → HeadObject
    expect(res.files[10].name).toBe('key:u10-f10.xlsx'); // index 10 → key 복원
  });

  it('fail-soft: 한 항목의 이름 조회가 throw 해도 상세 전체가 죽지 않고 폴백', async () => {
    // 비URL(스킴 없음) 단독 항목은 parseFilePathList 에서 앞 URL 에 안 붙고 그대로 남는다(맨 앞이라 직전 URL 없음).
    // 실제 코드에선 이런 항목이 getOriginalName 내부 new URL 에서 throw → getDetail 이 폴백해야 한다.
    const bad = 'brokenfrag';
    const good = 'https://b/private/5/u1-good.xlsx';
    const { sut } = makeSut([bad, good], {
      getOriginalName: jest.fn(async (u: string) => {
        if (u === bad) throw new Error('ERR_INVALID_URL');
        return `meta:${u.split('/').pop()}`;
      }),
    });

    const res = await sut.getDetail(admin, { id: 1 });

    expect(res.files[0]).toEqual({ url: bad, name: 'brokenfrag' }); // 마지막 경로조각으로 degrade
    expect(res.files[1]).toEqual({ url: good, name: 'meta:u1-good.xlsx' });
  });

  it('첨부 없음 → files 빈 배열', async () => {
    const { sut, fileService } = makeSut([]);
    const res = await sut.getDetail(admin, { id: 1 });
    expect(res.files).toEqual([]);
    expect(fileService.getOriginalName).not.toHaveBeenCalled();
  });
});
