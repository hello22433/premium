import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { RequirementService } from './requirement.service';
import { RequirementEntity } from '../../entity/requirement.entity';
import { RequirementCommentEntity } from '../../entity/requirement.comment.entity';
import { RequirementAttachmentEntity } from '../../entity/requirement.attachment.entity';
import { UserEntity } from '../../entity/user.entity';
import { RequirementUpdateReqDto, RequirementUpdateStatusReqDto } from '../api/requirement.req.dto';
import { RequirementType } from '../interface/requirement.type';
import { RequirementPriority } from '../interface/requirement.priority';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';
import { LoginUserInfoTest } from '../../../test/common/login.user.info.test';
import { ForbiddenException } from '@nestjs/common';
import { RequirementStatus } from '../interface/requirement.status';
import { EventEmitter2 } from '@nestjs/event-emitter';

const RequirementEntityMock = (): RequirementEntity =>
  ({
    id: 1,
    userId: 99,
    title: '테스트',
    content: '테스트',
    status: RequirementStatus.NEW,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  }) as unknown as RequirementEntity;

describe('requirement service test', () => {
  let sut: RequirementService;
  let requirementRepository: any = mock<Repository<RequirementEntity>>();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequirementService,
        {
          provide: getRepositoryToken(RequirementEntity),
          useValue: { ...requirementRepository, ...createMockRepositoryMethod() },
        },
        {
          provide: getRepositoryToken(RequirementCommentEntity),
          useValue: createMockRepositoryMethod(),
        },
        {
          provide: getRepositoryToken(RequirementAttachmentEntity),
          useValue: createMockRepositoryMethod(),
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: createMockRepositoryMethod(),
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
      ],
    }).compile();

    sut = module.get<RequirementService>(RequirementService);
    requirementRepository = module.get<Repository<RequirementEntity>>(getRepositoryToken(RequirementEntity));
  });

  describe('updateStatus 보안 테스트', () => {
    it('소유자가 아닌 OPERATION_ADMIN이 상태를 변경하려 하면 ForbiddenException', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.OPERATION_ADMIN };
      const givenBody: RequirementUpdateStatusReqDto = { status: RequirementStatus.IN_PROGRESS };

      requirementRepository.findOne.mockResolvedValue({ ...RequirementEntityMock(), userId: 99 });

      await expect(sut.updateStatus(givenUser, 1, givenBody)).rejects.toThrow(ForbiddenException);
    });

    it('SUPER_ADMIN은 타인의 요구사항 상태도 변경 가능', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.SUPER_ADMIN };
      const givenBody: RequirementUpdateStatusReqDto = { status: RequirementStatus.IN_PROGRESS };

      const requirement = { ...RequirementEntityMock(), userId: 99 };
      requirementRepository.findOne.mockResolvedValue(requirement);
      requirementRepository.save.mockResolvedValue(requirement);

      await sut.updateStatus(givenUser, 1, givenBody);

      expect(requirementRepository.save).toHaveBeenCalled();
    });

    it('소유자는 자신의 요구사항 상태 변경 가능', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.CORPORATE_ADMIN };
      const givenBody: RequirementUpdateStatusReqDto = { status: RequirementStatus.IN_PROGRESS };

      const requirement = { ...RequirementEntityMock(), userId: 1 };
      requirementRepository.findOne.mockResolvedValue(requirement);
      requirementRepository.save.mockResolvedValue(requirement);

      await sut.updateStatus(givenUser, 1, givenBody);

      expect(requirementRepository.save).toHaveBeenCalled();
    });
  });

  describe('update 보안 테스트', () => {
    const givenBody: RequirementUpdateReqDto = {
      id: 1,
      title: '수정',
      type: RequirementType.BUG,
      priority: RequirementPriority.NORMAL,
      content: '수정 내용',
      attachments: [],
    };

    it('소유자가 아닌 OPERATION_ADMIN이 수정하려 하면 ForbiddenException', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.OPERATION_ADMIN };

      requirementRepository.findOne.mockResolvedValue({ ...RequirementEntityMock(), userId: 99 });

      await expect(sut.update(givenUser, givenBody)).rejects.toThrow(ForbiddenException);
    });

    it('SUPER_ADMIN은 타인의 요구사항도 수정 가능', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.SUPER_ADMIN };

      const requirement = { ...RequirementEntityMock(), userId: 99 };
      requirementRepository.findOne.mockResolvedValue(requirement);
      requirementRepository.save.mockResolvedValue(requirement);

      await sut.update(givenUser, givenBody);

      expect(requirementRepository.save).toHaveBeenCalled();
    });

    it('소유자는 자신의 요구사항 수정 가능', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.CORPORATE_ADMIN };

      const requirement = { ...RequirementEntityMock(), userId: 1 };
      requirementRepository.findOne.mockResolvedValue(requirement);
      requirementRepository.save.mockResolvedValue(requirement);

      await sut.update(givenUser, givenBody);

      expect(requirementRepository.save).toHaveBeenCalled();
    });
  });

  describe('delete 보안 테스트', () => {
    it('소유자가 아닌 OPERATION_ADMIN이 삭제하려 하면 ForbiddenException', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.OPERATION_ADMIN };

      requirementRepository.findOne.mockResolvedValue({ ...RequirementEntityMock(), userId: 99 });

      await expect(sut.delete(givenUser, 1)).rejects.toThrow(ForbiddenException);
    });

    it('SUPER_ADMIN은 타인의 요구사항도 삭제 가능', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.SUPER_ADMIN };

      requirementRepository.findOne.mockResolvedValue({ ...RequirementEntityMock(), userId: 99 });

      await sut.delete(givenUser, 1);

      expect(requirementRepository.softDelete).toHaveBeenCalled();
    });

    it('소유자는 자신의 요구사항 삭제 가능', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.CORPORATE_ADMIN };

      requirementRepository.findOne.mockResolvedValue({ ...RequirementEntityMock(), userId: 1 });

      await sut.delete(givenUser, 1);

      expect(requirementRepository.softDelete).toHaveBeenCalled();
    });
  });
});
