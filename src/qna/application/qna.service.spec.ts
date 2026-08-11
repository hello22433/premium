import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { QnaService } from './qna.service';
import { QnaEntity } from '../../entity/qna.entity';
import { UserEntity } from '../../entity/user.entity';
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
  let userRepository: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QnaService,
        {
          provide: getRepositoryToken(QnaEntity),
          useValue: {
            ...qnaRepository,
            ...createMockRepositoryMethod(),
            findAndCount: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: { ...createMockRepositoryMethod(), findOneOrFail: jest.fn() },
        },
      ],
    }).compile();

    sut = module.get<QnaService>(QnaService);
    qnaRepository = module.get<Repository<QnaEntity>>(getRepositoryToken(QnaEntity));
    userRepository = module.get(getRepositoryToken(UserEntity));
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
        user: {
          company: { businessName: '테스트' },
          personName: '홍길동',
          email: 'test@test.com',
          personPhoneNumber: '010-0000-0000',
        },
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
  describe('작성자 스냅샷', () => {
    it('create 시 작성 당시 담당자명·회사명을 스냅샷으로 저장', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 7, authority: IUserAuthority.CORPORATE_ADMIN };
      userRepository.findOneOrFail.mockResolvedValue({ personName: '윤혜진', company: { businessName: '(주)밀텍산업' } });

      await sut.create(givenUser, {
        title: 't',
        content: 'c',
        filePathList: [],
        mainCategory: IQnaMainCategory.ETC,
      } as any);

      expect(qnaRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ snapshotPersonName: '윤혜진', snapshotBusinessName: '(주)밀텍산업' }),
      );
    });
    it('작성자 조회에 실패하면 스냅샷 없는 문의를 저장하지 않는다', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 7, authority: IUserAuthority.CORPORATE_ADMIN };
      userRepository.findOneOrFail.mockRejectedValue(new Error('user not found'));

      await expect(
        sut.create(givenUser, {
          title: 't',
          content: 'c',
          filePathList: [],
          mainCategory: IQnaMainCategory.ETC,
        } as any),
      ).rejects.toThrow('user not found');

      expect(qnaRepository.insert).not.toHaveBeenCalled();
    });

    it('getDetail: 스냅샷 기록 행은 담당자명이 바뀌어도 작성 당시 값 유지, 연락처는 live', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.CORPORATE_ADMIN };
      qnaRepository.findOne.mockResolvedValue({
        ...QnaEntityMock(),
        userId: 1,
        snapshotPersonName: '윤혜진',
        snapshotBusinessName: '(주)밀텍산업',
        user: {
          personName: '강한나',
          company: { businessName: '(주)밀텍산업' },
          email: 'live@test.com',
          personPhoneNumber: '010-1111-2222',
        },
      });

      const result = await sut.getDetail(givenUser, { id: 1 });

      expect(result.personName).toBe('윤혜진');
      expect(result.businessName).toBe('(주)밀텍산업');
      expect(result.userEmail).toBe('live@test.com');
      expect(result.userPhone).toBe('010-1111-2222');
    });

    it('getDetail: 레거시 행(스냅샷 NULL)은 현재 user 값으로 fallback', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.CORPORATE_ADMIN };
      qnaRepository.findOne.mockResolvedValue({
        ...QnaEntityMock(),
        userId: 1,
        snapshotPersonName: null,
        snapshotBusinessName: null,
        user: { personName: '강한나', company: { businessName: '(주)밀텍산업' }, email: 'e', personPhoneNumber: 'p' },
      });

      const result = await sut.getDetail(givenUser, { id: 1 });

      expect(result.personName).toBe('강한나');
    });
    it('getDetail: 스냅샷 행은 user 관계가 없어도 작성 당시 표시값을 반환한다', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.CORPORATE_ADMIN };
      qnaRepository.findOne.mockResolvedValue({
        ...QnaEntityMock(),
        userId: 1,
        snapshotPersonName: '윤혜진',
        snapshotBusinessName: '(주)밀텍산업',
        user: null,
      });

      const result = await sut.getDetail(givenUser, { id: 1 });

      expect(result.personName).toBe('윤혜진');
      expect(result.businessName).toBe('(주)밀텍산업');
      expect(result.userEmail).toBe('');
      expect(result.userPhone).toBe('');
    });

    it('getList: 스냅샷을 우선하고 레거시 행은 현재 user 값으로 fallback', async () => {
      qnaRepository.findAndCount.mockResolvedValue([
        [
          {
            ...QnaEntityMock(),
            snapshotPersonName: '윤혜진',
            snapshotBusinessName: '(주)밀텍산업',
            user: { personName: '강한나', company: { businessName: '(주)현재회사' } },
          },
          {
            ...QnaEntityMock(),
            id: 2,
            snapshotPersonName: null,
            snapshotBusinessName: null,
            user: { personName: '강한나', company: { businessName: '(주)현재회사' } },
          },
        ],
        2,
      ]);

      const result = await sut.getList(
        { ...LoginUserInfoTest(), authority: IUserAuthority.OPERATION_ADMIN },
        { page: 1, take: 10 },
      );

      expect(result.list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 1, personName: '윤혜진', businessName: '(주)밀텍산업' }),
          expect.objectContaining({ id: 2, personName: '강한나', businessName: '(주)현재회사' }),
        ]),
      );
    });
  });
});
