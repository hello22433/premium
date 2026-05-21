import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { QnaService } from './qna.service';
import { QnaEntity } from '../../entity/qna.entity';
import { QnaGetDetailReqParamDto, QnaUpdateAnswerReqDto } from '../api/qna.req.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';
import { LoginUserInfoTest } from '../../../test/common/login.user.info.test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { IQnaStatus } from '../interface/qna.status';
import { IQnaMainCategory } from '../interface/qna.category';

const QnaEntityMock = (): QnaEntity =>
  ({
    id: 1,
    userId: 99,
    title: '테스트',
    content: '테스트',
    answer: null,
    filePath: null,
    status: IQnaStatus.WAIT,
    mainCategory: IQnaMainCategory.CS,
    subCategory: null,
    registerDate: '2026-01-01',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    user: null,
  }) as unknown as QnaEntity;

describe('qna service test', () => {
  let sut: QnaService;
  let qnaRepository: any = mock<Repository<QnaEntity>>();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QnaService,
        {
          provide: getRepositoryToken(QnaEntity),
          useValue: {
            ...qnaRepository,
            ...createMockRepositoryMethod(),
          },
        },
      ],
    }).compile();

    sut = module.get<QnaService>(QnaService);
    qnaRepository = module.get<Repository<QnaEntity>>(getRepositoryToken(QnaEntity));
  });

  describe('getDetail 보안 테스트', () => {
    it('CORPORATE_ADMIN이 타인의 문의를 조회하면 ForbiddenException', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.CORPORATE_ADMIN };
      const givenParam: QnaGetDetailReqParamDto = { id: 1 };

      qnaRepository.findOne.mockResolvedValue({ ...QnaEntityMock(), userId: 99 });

      await expect(sut.getDetail(givenUser, givenParam)).rejects.toThrow(ForbiddenException);
    });

    it('CORPORATE_ADMIN이 자신의 문의를 조회하면 성공', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.CORPORATE_ADMIN };
      const givenParam: QnaGetDetailReqParamDto = { id: 1 };

      qnaRepository.findOne.mockResolvedValue({
        ...QnaEntityMock(),
        userId: 1,
        user: { company: { businessName: '테스트' }, personName: '홍길동', email: 'test@test.com', personPhoneNumber: '010-0000-0000' },
      });

      const result = await sut.getDetail(givenUser, givenParam);
      expect(result.id).toBe(1);
    });
  });

  describe('update 보안 테스트', () => {
    it('CORPORATE_ADMIN이 답변을 수정하려 하면 ForbiddenException', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), authority: IUserAuthority.CORPORATE_ADMIN };
      const givenBody: QnaUpdateAnswerReqDto = { id: 1, answer: '수정된 답변' };

      qnaRepository.findOne.mockResolvedValue(QnaEntityMock());

      await expect(sut.update(givenUser, givenBody)).rejects.toThrow(ForbiddenException);
    });

    it('OPERATION_ADMIN이 답변을 수정하면 성공', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), authority: IUserAuthority.OPERATION_ADMIN };
      const givenBody: QnaUpdateAnswerReqDto = { id: 1, answer: '수정된 답변' };

      qnaRepository.findOne.mockResolvedValue(QnaEntityMock());

      await sut.update(givenUser, givenBody);

      expect(qnaRepository.update).toHaveBeenCalled();
    });
  });
});
