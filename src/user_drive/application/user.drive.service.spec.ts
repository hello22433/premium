import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserDriveService } from './user.drive.service';
import { UserDriveEntity } from '../../entity/user.drive.entity';
import { UserEntity } from '../../entity/user.entity';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { createMockQueryBuilder } from '../../common/test/mock.query.builder';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserDriveStatus } from '../interface/user.drive.status';
import { FileService } from '../../file/application/file.service';

describe('UserDriveService', () => {
  let sut: UserDriveService;
  let userDriveRepository: any;
  let userRepository: any;
  let queryBuilder: any;

  const CORPORATE_ADMIN_USER = { id: 5, email: 'corp@test.com', authority: IUserAuthority.CORPORATE_ADMIN };
  const OPERATION_ADMIN_USER = { id: 10, email: 'op@test.com', authority: IUserAuthority.OPERATION_ADMIN };
  const SUPER_ADMIN_USER = { id: 1, email: 'super@test.com', authority: IUserAuthority.SUPER_ADMIN };

  const BASE_UPDATE_BODY = {
    id: 1,
    receiverId: 99,
    title: '수정 제목',
    content: '수정 내용',
    filePath: [],
    status: IUserDriveStatus.REGISTER,
  };

  beforeEach(async () => {
    queryBuilder = createMockQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserDriveService,
        {
          provide: getRepositoryToken(UserDriveEntity),
          useValue: { ...createMockRepositoryMethod(), createQueryBuilder: jest.fn(() => queryBuilder) },
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: createMockRepositoryMethod(),
        },
        {
          // getDetail 의 첨부 원본명 조회에만 쓰임 — 이 spec 은 그 외 로직만 검증하므로 단순 stub
          provide: FileService,
          useValue: {
            getOriginalName: jest.fn().mockResolvedValue('file.xlsx'),
            extractOriginalFileName: jest.fn().mockReturnValue('file.xlsx'),
            extractStorageKey: jest.fn().mockReturnValue(''),
            isOwnStorageUrl: jest.fn().mockReturnValue(true),
            downloadWithPath: jest.fn(),
          },
        },
      ],
    }).compile();

    sut = module.get<UserDriveService>(UserDriveService);
    userDriveRepository = module.get(getRepositoryToken(UserDriveEntity));
    userRepository = module.get(getRepositoryToken(UserEntity));
  });

  describe('update 소유권 검증', () => {
    it('CORPORATE_ADMIN → BadRequestException', async () => {
      await expect(sut.update(CORPORATE_ADMIN_USER, BASE_UPDATE_BODY)).rejects.toThrow(
        new BadRequestException('관리자만 접근 가능합니다.'),
      );
    });

    it('OPERATION_ADMIN + 본인 문서 → 수정 성공', async () => {
      userDriveRepository.findOne.mockResolvedValueOnce({ id: 1, senderId: 10 });
      userRepository.findOne.mockResolvedValue({ id: 99 });
      userDriveRepository.save.mockResolvedValue({});

      await sut.update(OPERATION_ADMIN_USER, BASE_UPDATE_BODY);

      expect(userDriveRepository.save).toHaveBeenCalled();
    });

    it('OPERATION_ADMIN + 타인 문서 → ForbiddenException', async () => {
      userDriveRepository.findOne.mockResolvedValue({ id: 1, senderId: 99 }); // 다른 사람이 만든 문서

      await expect(sut.update(OPERATION_ADMIN_USER, BASE_UPDATE_BODY)).rejects.toThrow(ForbiddenException);
      expect(userDriveRepository.save).not.toHaveBeenCalled();
    });

    it('OPERATION_ADMIN + 문서 없음 → BadRequestException', async () => {
      userDriveRepository.findOne.mockResolvedValue(null);

      await expect(sut.update(OPERATION_ADMIN_USER, BASE_UPDATE_BODY)).rejects.toThrow(
        new BadRequestException('문서가 존재하지 않습니다.'),
      );
    });

    it('SUPER_ADMIN + 타인 문서 → 수정 성공 (소유권 제한 없음)', async () => {
      userDriveRepository.findOne.mockResolvedValueOnce({ id: 1, senderId: 10 }); // 다른 사람이 만든 문서
      userRepository.findOne.mockResolvedValue({ id: 99 });
      userDriveRepository.save.mockResolvedValue({});

      await sut.update(SUPER_ADMIN_USER, BASE_UPDATE_BODY);

      expect(userDriveRepository.save).toHaveBeenCalled();
    });
  });

  describe('delete 소유권 검증', () => {
    it('CORPORATE_ADMIN → BadRequestException', async () => {
      await expect(sut.delete(CORPORATE_ADMIN_USER, 1)).rejects.toThrow(
        new BadRequestException('관리자만 접근 가능합니다.'),
      );
      expect(userDriveRepository.softDelete).not.toHaveBeenCalled();
    });

    it('문서 없음 → BadRequestException', async () => {
      userDriveRepository.findOne.mockResolvedValue(null);

      await expect(sut.delete(OPERATION_ADMIN_USER, 1)).rejects.toThrow(
        new BadRequestException('문서가 존재하지 않습니다.'),
      );
      expect(userDriveRepository.softDelete).not.toHaveBeenCalled();
    });

    it('OPERATION_ADMIN + 본인 문서 → 삭제 성공', async () => {
      userDriveRepository.findOne.mockResolvedValue({ id: 1, senderId: 10 });
      userDriveRepository.softDelete.mockResolvedValue({});

      await sut.delete(OPERATION_ADMIN_USER, 1);

      expect(userDriveRepository.softDelete).toHaveBeenCalledWith(1);
    });

    it('OPERATION_ADMIN + 타인 문서 → ForbiddenException', async () => {
      userDriveRepository.findOne.mockResolvedValue({ id: 1, senderId: 99 }); // 다른 사람이 만든 문서

      await expect(sut.delete(OPERATION_ADMIN_USER, 1)).rejects.toThrow(ForbiddenException);
      expect(userDriveRepository.softDelete).not.toHaveBeenCalled();
    });

    it('SUPER_ADMIN + 타인 문서 → 삭제 성공 (소유권 제한 없음)', async () => {
      userDriveRepository.findOne.mockResolvedValue({ id: 1, senderId: 10 }); // 다른 사람이 만든 문서
      userDriveRepository.softDelete.mockResolvedValue({});

      await sut.delete(SUPER_ADMIN_USER, 1);

      expect(userDriveRepository.softDelete).toHaveBeenCalledWith(1);
    });
  });
});
