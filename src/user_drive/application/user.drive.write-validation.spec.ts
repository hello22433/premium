import { BadRequestException } from '@nestjs/common';
import { UserDriveService } from './user.drive.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserDriveStatus } from '../interface/user.drive.status';

/**
 * 넣을 때(쓰기) 검증 회귀 — confused-deputy 차단(운영자가 남의 private URL 을 문서에 심는 것).
 *  - 새로 추가되는 첨부만 검사: private 는 본인(등록자) 업로드여야, 공개 레거시(image//file/)는 허용, 외부/기타 차단.
 *  - 기존 첨부는 재검증하지 않음 → SUPER 교차수정이 남긴 타인 소유 첨부/발신자 첨부 보존.
 */
describe('UserDriveService 쓰기 검증 (create/update)', () => {
  const op10 = { id: 10, authority: IUserAuthority.OPERATION_ADMIN } as any; // 발신자
  const super1 = { id: 1, authority: IUserAuthority.SUPER_ADMIN } as any;

  const ownPrivate = (ownerId: number) => `https://b.s3.amazonaws.com/private/${ownerId}/0123456789abcdef-a.xlsx`;
  const legacyImage = 'https://b.s3.amazonaws.com/image/abc-legacy.png';
  const external = 'https://evil.example.com/private/10/x.xlsx';
  // ★ 콤마 밀반입: 원소 1개지만 저장(join)·복원(parseFilePathList) 을 거치면 2개가 된다.
  //   앞쪽 URL 의 owner 가 본인이라 소유 검증은 통과한다 — 왕복 검증만이 잡는다.
  const smuggled = `${ownPrivate(10)}?x=,${ownPrivate(99)}`;
  const smuggledNoQuery = `https://b.s3.amazonaws.com/private/10/a,${ownPrivate(99)}`;
  // 파일명에 정상적으로 콤마가 든 첨부 — 왕복이 보존되므로 막히면 안 된다(과차단 회귀).
  const commaInName = 'https://b.s3.amazonaws.com/private/10/0123456789abcdef-보고서,최종.xlsx';
  // 깨진 percent-encoding — new URL 은 통과시키지만 decodeURIComponent 가 URIError 를 던진다.
  const brokenEncoding = 'https://b.s3.amazonaws.com/private/10/%';

  const makeSut = (existingFilePath: string | null = null) => {
    const drive = {
      id: 1,
      senderId: 10,
      receiverId: 20,
      status: IUserDriveStatus.REGISTER,
      filePath: existingFilePath,
    };
    const driveRepo: any = {
      findOne: jest.fn().mockResolvedValue(drive),
      insert: jest.fn().mockResolvedValue({}),
      save: jest.fn().mockResolvedValue({}),
    };
    const userRepo: any = { findOne: jest.fn().mockResolvedValue({ id: 20 }) }; // 수신자 존재
    const fileService: any = {
      isOwnStorageUrl: jest.fn().mockReturnValue(true),
      // 실제 구현과 동일하게 decodeURIComponent 까지 — 이게 빠지면 깨진 percent-encoding 케이스가 안 돈다.
      extractStorageKey: (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\/+/, '')),
    };
    return { sut: new UserDriveService(driveRepo, userRepo, fileService), driveRepo, fileService };
  };

  const createBody = (filePath: string[]) => ({
    title: 't',
    content: 'c',
    receiverId: 20,
    filePath,
    status: IUserDriveStatus.REGISTER,
  });
  const updateBody = (filePath: string[]) => ({ id: 1, ...createBody(filePath) });

  describe('create', () => {
    it('본인이 올린 private 첨부 → 통과', async () => {
      const { sut, driveRepo } = makeSut();
      await sut.create(op10, createBody([ownPrivate(10)]));
      expect(driveRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('남(다른 id)이 올린 private 첨부를 심으면 → BadRequest, insert 안 함', async () => {
      const { sut, driveRepo } = makeSut();
      await expect(sut.create(op10, createBody([ownPrivate(99)]))).rejects.toBeInstanceOf(BadRequestException);
      expect(driveRepo.insert).not.toHaveBeenCalled();
    });

    it('공개 레거시(image/) 첨부 → 통과 (유출 아님·전환 호환)', async () => {
      const { sut, driveRepo } = makeSut();
      await sut.create(op10, createBody([legacyImage]));
      expect(driveRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('외부 host URL → BadRequest', async () => {
      const { sut, driveRepo, fileService } = makeSut();
      fileService.isOwnStorageUrl.mockReturnValue(false);
      await expect(sut.create(op10, createBody([external]))).rejects.toBeInstanceOf(BadRequestException);
      expect(driveRepo.insert).not.toHaveBeenCalled();
    });

    it('첨부 없음 → 통과', async () => {
      const { sut, driveRepo } = makeSut();
      await sut.create(op10, createBody([]));
      expect(driveRepo.insert).toHaveBeenCalledTimes(1);
    });

    // ★ 소유 검증만으로는 못 잡는다 — 앞쪽 URL 의 owner 가 본인이라 통과해버린다.
    //   저장 후 복원하면 owner 99 첨부가 별도로 생겨 검증을 안 거친 객체가 들어온다.
    it('★`,https://` 를 심은 원소 → BadRequest, insert 안 함 (쿼리로 가린 형태)', async () => {
      const { sut, driveRepo } = makeSut();
      await expect(sut.create(op10, createBody([smuggled]))).rejects.toBeInstanceOf(BadRequestException);
      expect(driveRepo.insert).not.toHaveBeenCalled();
    });

    it('★쿼리 없이 경로에 이어붙인 밀반입도 → BadRequest, insert 안 함', async () => {
      const { sut, driveRepo } = makeSut();
      await expect(sut.create(op10, createBody([smuggledNoQuery]))).rejects.toBeInstanceOf(BadRequestException);
      expect(driveRepo.insert).not.toHaveBeenCalled();
    });

    it('★정상 첨부 사이에 밀반입 하나만 섞여도 → BadRequest, insert 안 함', async () => {
      const { sut, driveRepo } = makeSut();
      await expect(sut.create(op10, createBody([ownPrivate(10), smuggled]))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(driveRepo.insert).not.toHaveBeenCalled();
    });

    // 과차단 회귀 — 왕복이 보존되는 정상 입력까지 막으면 이 검사는 쓸 수 없다.
    it('파일명에 콤마가 든 정상 첨부 → 통과', async () => {
      const { sut, driveRepo } = makeSut();
      await sut.create(op10, createBody([commaInName]));
      expect(driveRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('깨진 percent-encoding key → BadRequest (500 아님), insert 안 함', async () => {
      const { sut, driveRepo } = makeSut();
      await expect(sut.create(op10, createBody([brokenEncoding]))).rejects.toBeInstanceOf(BadRequestException);
      expect(driveRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('update (델타만 검증)', () => {
    it('새로 본인 private 추가 → 통과', async () => {
      const { sut, driveRepo } = makeSut(ownPrivate(10)); // 기존: 본인 것 하나
      await sut.update(op10, updateBody([ownPrivate(10), 'https://b.s3.amazonaws.com/private/10/new-b.xlsx']));
      expect(driveRepo.save).toHaveBeenCalledTimes(1);
    });

    it('새로 남의 private 추가 → BadRequest, save 안 함', async () => {
      const { sut, driveRepo } = makeSut(ownPrivate(10));
      await expect(sut.update(op10, updateBody([ownPrivate(10), ownPrivate(99)]))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(driveRepo.save).not.toHaveBeenCalled();
    });

    it('★기존 타인(SUPER) 소유 첨부를 되보내도 → 통과 (기존은 재검증 안 함)', async () => {
      // 기존 목록에 SUPER(1)가 교차수정으로 남긴 첨부가 있음. 발신자(op10)가 제목만 고치며 그대로 되보냄.
      const superAdded = ownPrivate(1);
      const { sut, driveRepo } = makeSut(superAdded);
      await sut.update(op10, updateBody([superAdded]));
      expect(driveRepo.save).toHaveBeenCalledTimes(1);
    });

    it('★SUPER 교차수정으로 본인(SUPER) private 새로 추가 → 통과', async () => {
      const { sut, driveRepo } = makeSut(ownPrivate(10)); // 발신자(10) 문서, SUPER 가 편집
      await sut.update(super1, updateBody([ownPrivate(10), ownPrivate(1)]));
      expect(driveRepo.save).toHaveBeenCalledTimes(1);
    });

    it('새로 공개 레거시(image/) 추가 → 통과', async () => {
      const { sut, driveRepo } = makeSut(ownPrivate(10));
      await sut.update(op10, updateBody([ownPrivate(10), legacyImage]));
      expect(driveRepo.save).toHaveBeenCalledTimes(1);
    });

    it('★`,https://` 를 심은 원소를 새로 추가 → BadRequest, save 안 함', async () => {
      const { sut, driveRepo } = makeSut(ownPrivate(10));
      await expect(sut.update(op10, updateBody([ownPrivate(10), smuggled]))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(driveRepo.save).not.toHaveBeenCalled();
    });

    // ★ 왕복 검증은 '저장될 배열 전체' 에 걸어야 한다. 델타만 보면 기존 항목으로 위장한 밀반입을 놓친다.
    it('★밀반입 원소가 기존 목록에 이미 있는 것처럼 와도 → BadRequest, save 안 함', async () => {
      const { sut, driveRepo } = makeSut(smuggled); // 기존 filePath 자체가 밀반입 값인 상황
      await expect(sut.update(op10, updateBody([smuggled]))).rejects.toBeInstanceOf(BadRequestException);
      expect(driveRepo.save).not.toHaveBeenCalled();
    });

    it('깨진 percent-encoding key 를 새로 추가 → BadRequest, save 안 함', async () => {
      const { sut, driveRepo } = makeSut(ownPrivate(10));
      await expect(sut.update(op10, updateBody([ownPrivate(10), brokenEncoding]))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(driveRepo.save).not.toHaveBeenCalled();
    });
  });
});

/**
 * ★ 밀반입 '최초 시도' 가 잡히는 유일한 자리다. 여기에 로그가 없으면 반복 시도인지 오타인지도 못 가른다.
 */
describe('UserDriveService.create — 첨부 거절의 관측', () => {
  const admin = { id: 10, authority: IUserAuthority.OPERATION_ADMIN } as any;
  const foreignUrl = 'https://b.s3.amazonaws.com/private/99/0123456789abcdef-대외비.pdf';

  const makeSut = () => {
    const driveRepo: any = { insert: jest.fn(), findOne: jest.fn() };
    const userRepo: any = { findOne: jest.fn().mockResolvedValue({ id: 20 }) };
    const fileService: any = {
      extractStorageKey: (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\/+/, '')),
      isOwnStorageUrl: jest.fn().mockReturnValue(true),
    };
    const sut = new UserDriveService(driveRepo, userRepo, fileService);
    const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    (sut as any).logger = logger;
    return { sut, logger, driveRepo };
  };

  it('★본인이 올리지 않은 private 첨부를 거절하면 경고 1회 + 저장 안 함', async () => {
    const { sut, logger, driveRepo } = makeSut();
    await expect(
      sut.create(admin, { title: 't', content: 'c', receiverId: 20, filePath: [foreignUrl] } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(driveRepo.insert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const logged = logger.warn.mock.calls[0][0] as string;
    expect(logged).not.toContain('대외비');
    expect(logged).toContain('private/99/');
  });
});
