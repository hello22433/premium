import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserDriveService } from './user.drive.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserDriveStatus } from '../interface/user.drive.status';

/**
 * 문서함 첨부 다운로드 프록시 회귀 — 문서권한 / 첨부귀속 / 객체소유(우회 차단) / 원본명.
 *  - 문서권한: 관리자=전체, 기업관리자=본인 수신 문서(비DRAFT)만. 권한 밖은 "문서 없음"(BadRequest)로 통일(존재 은닉).
 *  - 객체소유(글쓰기 권한과 통일): 관리자 아닌 요청자에겐 key 의 ownerId 가 발신자(senderId)이거나 SUPER 인
 *    첨부만 허용. 발신자 본인은 조회 없이 통과, 그 외는 업로더가 SUPER 인 경우만 예외 허용.
 *    ※ 발신 아닌 다른 운영관리자/기업계정의 key 는 차단되고, SUPER 교차수정 첨부는 과차단하지 않는다.
 */
describe('UserDriveService.downloadFile', () => {
  // 발신자 id=5(OPERATION), 수신자(기업) id=10 인 문서. 신 key 는 private/{업로더id}/...
  const ownUrl = 'https://b.s3.amazonaws.com/private/5/0123456789abcdef0123456789abcdef-보고서.xlsx';
  // SUPER(id=8)가 교차수정으로 추가한 첨부 — 발신자는 아니지만 SUPER 라 수신자도 받을 수 있어야 함(과차단 없음)
  const superAddedUrl = 'https://b.s3.amazonaws.com/private/8/8888888888888888aaaaaaaaaaaaaaaa-공지.xlsx';
  // 발신자도 SUPER 도 아닌 다른 운영관리자(id=6)의 첨부 — 이 문서에 글 쓸 수 없던 사람 → 차단
  const otherOpAdminUrl = 'https://b.s3.amazonaws.com/private/6/6666666666666666bbbbbbbbbbbbbbbb-외부.xlsx';
  // ownerId=77 은 비관리자(기업) — 차단
  const foreignUrl = 'https://b.s3.amazonaws.com/private/77/ffffffffffffffffffffffffffffffff-남의것.xlsx';
  // ownerId=404 는 존재하지 않는 사용자 — 차단
  const ghostUrl = 'https://b.s3.amazonaws.com/private/404/dddddddddddddddddddddddddddddddd-유령.xlsx';

  // 업로더 id → 권한. (발신자 5 는 senderId 단축으로 조회 없이 통과하므로 맵에 없어도 됨)
  const USERS: Record<number, IUserAuthority> = {
    6: IUserAuthority.OPERATION_ADMIN,
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

  it('★수신자(기업)가 발신자 첨부를 다운로드 → 허용 (senderId 단축, 업로더 조회 없음)', async () => {
    const { sut, fileService, userRepo } = makeSut(ownUrl);
    const r = await sut.downloadFile(receiver, 1, ownUrl);
    expect(r).toEqual({ fileName: '보고서.xlsx', filePath: '/tmp/x.xlsx' });
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
    expect(userRepo.findOne).not.toHaveBeenCalled(); // ownerId===senderId 라 조회 불필요
  });

  it('★수신자가 SUPER 교차수정 첨부(≠발신자)를 다운로드 → 허용 (과차단 없음)', async () => {
    const { sut, fileService, userRepo } = makeSut(superAddedUrl);
    await expect(sut.downloadFile(receiver, 1, superAddedUrl)).resolves.toBeDefined();
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
    expect(userRepo.findOne).toHaveBeenCalledTimes(1); // 발신자 아니라 업로더 권한 조회
  });

  it('★차단: 발신자도 SUPER 도 아닌 다른 운영관리자 첨부 → Forbidden (글쓰기 권한과 통일)', async () => {
    const { sut, fileService } = makeSut(otherOpAdminUrl);
    await expect(sut.downloadFile(receiver, 1, otherOpAdminUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('관리자 → 허용 (업로더 조회 없이 통과)', async () => {
    const { sut, userRepo } = makeSut(superAddedUrl);
    await expect(sut.downloadFile(admin, 1, superAddedUrl)).resolves.toBeDefined();
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('비수신 기업관리자 → BadRequest (문서 존재 은닉)', async () => {
    const { sut, fileService } = makeSut(ownUrl);
    await expect(sut.downloadFile(otherCorp, 1, ownUrl)).rejects.toBeInstanceOf(BadRequestException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('DRAFT 문서는 수신 기업관리자도 접근 불가 → BadRequest (문서 존재 은닉)', async () => {
    const { sut, fileService } = makeSut(ownUrl, { status: IUserDriveStatus.DRAFT });
    await expect(sut.downloadFile(receiver, 1, ownUrl)).rejects.toBeInstanceOf(BadRequestException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('첨부에 없는 url → BadRequest, 다운로드 시도 안 함', async () => {
    const { sut, fileService } = makeSut(ownUrl);
    const notAttached = 'https://b.s3.amazonaws.com/private/5/aaaa-다른것.xlsx';
    await expect(sut.downloadFile(receiver, 1, notAttached)).rejects.toBeInstanceOf(BadRequestException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★차단: 업로더가 비관리자(기업)인 private key 를 심어도 → Forbidden', async () => {
    const { sut, fileService } = makeSut(foreignUrl);
    await expect(sut.downloadFile(receiver, 1, foreignUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★차단: 존재하지 않는 업로더 id 의 private key → Forbidden', async () => {
    const { sut, fileService } = makeSut(ghostUrl);
    await expect(sut.downloadFile(receiver, 1, ghostUrl)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★차단: 우리 버킷 host 가 아닌 URL → Forbidden', async () => {
    const external = 'https://evil.example.com/private/5/abc-x.xlsx';
    const { sut, fileService } = makeSut(external);
    fileService.isOwnStorageUrl.mockReturnValue(false);
    await expect(sut.downloadFile(receiver, 1, external)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★차단: ownerId 세그먼트 없는 구 private key → Forbidden', async () => {
    const legacyPrivate = 'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-list.xlsx';
    const { sut, fileService } = makeSut(legacyPrivate);
    await expect(sut.downloadFile(receiver, 1, legacyPrivate)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('레거시 공개 첨부(image/) 는 호환 허용 (문서함 실제 레거시 접두사)', async () => {
    const imageUrl = 'https://b.s3.amazonaws.com/image/abc-banner.png';
    const { sut, fileService } = makeSut(imageUrl);
    await expect(sut.downloadFile(receiver, 1, imageUrl)).resolves.toBeDefined();
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
  });

  it('★차단: 첨부 위치가 아닌 접두사(export/ 등) → Forbidden', async () => {
    const other = 'https://b.s3.amazonaws.com/export/abc-report.xlsx';
    const { sut, fileService } = makeSut(other);
    await expect(sut.downloadFile(receiver, 1, other)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('레거시 공개 첨부(file/) 는 호환 허용 (전환 전 문서함 첨부)', async () => {
    const legacyPublic = 'https://b.s3.amazonaws.com/file/1780551879605-주문서.xlsx';
    const { sut, fileService } = makeSut(legacyPublic);
    await expect(sut.downloadFile(receiver, 1, legacyPublic)).resolves.toBeDefined();
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
  });

  it('문서가 존재하지 않으면 → BadRequest (권한/첨부 검사 전)', async () => {
    const driveRepo: any = { findOne: jest.fn().mockResolvedValue(null) };
    const sut = new UserDriveService(driveRepo, {} as any, {} as any);
    await expect(sut.downloadFile(receiver, 1, ownUrl)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('다중 첨부 중 하나(발신자 첨부)를 다운로드 → 허용 (콤마조인 목록에서 정확 매칭)', async () => {
    const multi = [
      'https://b.s3.amazonaws.com/private/5/aaa-A.xlsx',
      ownUrl,
      'https://b.s3.amazonaws.com/private/5/ccc-C.xlsx',
    ].join(',');
    const { sut, fileService } = makeSut(multi);
    await expect(sut.downloadFile(receiver, 1, ownUrl)).resolves.toBeDefined();
    expect(fileService.downloadWithPath).toHaveBeenCalledTimes(1);
  });

  it('실 첨부의 부분문자열(항목이 아님) → BadRequest (includes 는 정확일치)', async () => {
    const { sut, fileService } = makeSut(ownUrl);
    const fragment = ownUrl.slice(0, ownUrl.length - 5);
    await expect(sut.downloadFile(receiver, 1, fragment)).rejects.toBeInstanceOf(BadRequestException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('★차단: private// (owner 세그먼트 빈 값) → Forbidden (숫자 아님)', async () => {
    const emptyOwner = 'https://b.s3.amazonaws.com/private//0123456789abcdef-x.xlsx';
    const { sut, fileService } = makeSut(emptyOwner);
    await expect(sut.downloadFile(receiver, 1, emptyOwner)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fileService.downloadWithPath).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN 요청자 → 허용 (관리자는 객체소유 검사 없이 통과)', async () => {
    const superReq = { id: 1, authority: IUserAuthority.SUPER_ADMIN } as any;
    const { sut, userRepo } = makeSut(foreignUrl); // 업로더가 비관리자여도 관리자 요청자는 통과
    await expect(sut.downloadFile(superReq, 1, foreignUrl)).resolves.toBeDefined();
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });
});
