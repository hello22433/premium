import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserDriveService } from './user.drive.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserDriveStatus } from '../interface/user.drive.status';

/**
 * 문서함 첨부 다운로드 프록시 회귀 — 문서권한 / 첨부귀속 / 객체소유(우회 차단) / 원본명.
 *  - 문서권한: 관리자=전체, 기업관리자=본인 수신 문서(비DRAFT)만.
 *  - 객체소유: 문서함 첨부는 관리자만 등록하므로 정당한 첨부의 업로더(key 의 private/{ownerId}/)는 항상 관리자.
 *    관리자 아닌 요청자(기업 수신자)에게는 "업로더가 관리자인 첨부"만 허용 → 심어진 타인(비관리자) 객체 차단.
 *    ※ 발신자 본인뿐 아니라 다른 관리자(SUPER 교차수정 추가)가 올린 첨부도 정상 다운로드됨.
 */
describe('UserDriveService.downloadFile', () => {
  // 발신자 id=5(OPERATION 관리자), 수신자(기업) id=10 인 문서. 신 key 는 private/{업로더id}/...
  const ownUrl = 'https://b.s3.amazonaws.com/private/5/0123456789abcdef0123456789abcdef-보고서.xlsx';
  // 발신자 아닌 다른 관리자(id=8, SUPER)가 교차수정으로 추가한 첨부 — 수신자도 받을 수 있어야 함(과차단 없음)
  const otherAdminUrl = 'https://b.s3.amazonaws.com/private/8/8888888888888888aaaaaaaaaaaaaaaa-공지.xlsx';
  // ownerId=77 은 비관리자(기업) — filePath 에 섞여도 수신자가 받으면 안 됨
  const foreignUrl = 'https://b.s3.amazonaws.com/private/77/ffffffffffffffffffffffffffffffff-남의것.xlsx';
  // ownerId=404 는 존재하지 않는 사용자 — 차단
  const ghostUrl = 'https://b.s3.amazonaws.com/private/404/dddddddddddddddddddddddddddddddd-유령.xlsx';

  // 업로더 id → 권한. 관리자면 수신자 다운로드 허용, 비관리자/없음이면 차단.
  const USERS: Record<number, IUserAuthority> = {
    5: IUserAuthority.OPERATION_ADMIN,
    8: IUserAuthority.SUPER_ADMIN,
    77: IUserAuthority.CORPORATE_ADMIN,
  };

  const makeSut = (filePath: string, driveOverrides: Record<string, any> = {}) => {
    const drive = {
      id: 1,
      senderId: 5,
      receiverId: 10,
      status: IUserDriveStatus.REGISTER,
      filePath,
      ...driveOverrides,
    };
    const driveRepo: any = { findOne: jest.fn().mockResolvedValue(drive) };
    const userRepo: any = {
      findOne: jest.fn(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(USERS[id] ? { id, authority: USERS[id] } : null),
      ),
    };
    const fileService: any = {
      extractStorageKey: (url: string) => new URL(url).pathname.replace(/^\/+/, ''),
      isOwnStorageUrl: jest.fn().mockReturnValue(true),
      getOriginalName: jest.fn().mockResolvedValue('보고서.xlsx'),
      downloadWithPath: jest.fn().mockResolvedValue('/tmp/x.xlsx'),
    };
    // 생성자: (userDriveRepository, userRepository, fileService)
    return { sut: new UserDriveService(driveRepo, userRepo, fileService), fileService, userRepo };
  };

  const receiver = { id: 10, authority: IUserAuthority.CORPORATE_ADMIN } as any;
  const otherCorp = { id: 11, authority: IUserAuthority.CORPORATE_ADMIN } as any;
  const admin = { id: 99, authority: IUserAuthority.OPERATION_ADMIN } as any;

  it('★수신자(기업, ≠업로더)가 발신자 첨부를 다운로드 → 허용', async () => {
    const { sut, fileService } = makeSut(ownUrl);
    const r = await sut.downloadFile(receiver, 1, ownUrl);
    expect(r).toEqual({ fileName: '보고서.xlsx', filePath: '/tmp/x.xlsx' });
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
  });

  it('★수신자가 다른 관리자(SUPER 교차수정)가 올린 첨부를 다운로드 → 허용 (과차단 없음)', async () => {
    const { sut, fileService } = makeSut(otherAdminUrl);
    await expect(sut.downloadFile(receiver, 1, otherAdminUrl)).resolves.toBeDefined();
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
  });

  it('관리자 → 허용 (업로더 조회 없이 통과)', async () => {
    const { sut, userRepo } = makeSut(ownUrl);
    await expect(sut.downloadFile(admin, 1, ownUrl)).resolves.toBeDefined();
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('비수신 기업관리자 → Forbidden (문서 접근 불가)', async () => {
    const { sut, fileService } = makeSut(ownUrl);
    await expect(sut.downloadFile(otherCorp, 1, ownUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('DRAFT 문서는 수신 기업관리자도 접근 불가 → Forbidden', async () => {
    const { sut, fileService } = makeSut(ownUrl, { status: IUserDriveStatus.DRAFT });
    await expect(sut.downloadFile(receiver, 1, ownUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('첨부에 없는 url → BadRequest, 다운로드 시도 안 함', async () => {
    const { sut, fileService } = makeSut(ownUrl);
    const notAttached = 'https://b.s3.amazonaws.com/private/5/aaaa-다른것.xlsx';
    await expect(sut.downloadFile(receiver, 1, notAttached)).rejects.toBeInstanceOf(BadRequestException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★우회 차단: 업로더가 비관리자(기업)인 private key 를 심어도 → Forbidden', async () => {
    // foreignUrl(ownerId=77, CORPORATE_ADMIN) 이 filePath 에 있어 includes() 는 통과하지만 업로더가 비관리자
    const { sut, fileService } = makeSut(foreignUrl);
    await expect(sut.downloadFile(receiver, 1, foreignUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★우회 차단: 존재하지 않는 업로더 id 의 private key → Forbidden', async () => {
    const { sut, fileService } = makeSut(ghostUrl);
    await expect(sut.downloadFile(receiver, 1, ghostUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★우회 차단: 우리 버킷 host 가 아닌 URL → Forbidden', async () => {
    const external = 'https://evil.example.com/private/5/abc-x.xlsx';
    const { sut, fileService } = makeSut(external);
    fileService.isOwnStorageUrl.mockReturnValue(false);
    await expect(sut.downloadFile(receiver, 1, external)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★우회 차단: ownerId 세그먼트 없는 구 private key → Forbidden', async () => {
    const legacyPrivate = 'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-list.xlsx';
    const { sut, fileService } = makeSut(legacyPrivate);
    await expect(sut.downloadFile(receiver, 1, legacyPrivate)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★우회 차단: image/ 등 첨부 외 위치 → Forbidden (file/ 레거시만 허용)', async () => {
    const imageUrl = 'https://b.s3.amazonaws.com/image/abc-banner.png';
    const { sut, fileService } = makeSut(imageUrl);
    await expect(sut.downloadFile(receiver, 1, imageUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('레거시 공개 첨부(file/) 는 호환 허용 (전환 전 문서함 첨부)', async () => {
    const legacyPublic = 'https://b.s3.amazonaws.com/file/1780551879605-주문서.xlsx';
    const { sut, fileService } = makeSut(legacyPublic);
    await expect(sut.downloadFile(receiver, 1, legacyPublic)).resolves.toBeDefined();
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
  });
});
