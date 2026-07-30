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
      extractStorageKey: (url: string) => new URL(url).pathname.replace(/^\/+/, ''),
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
  });
});
