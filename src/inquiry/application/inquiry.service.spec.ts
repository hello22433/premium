import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { createMockQueryBuilder } from '../../common/test/mock.query.builder';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { InquiryService } from './inquiry.service';
import { InquiryEntity } from '../../entity/inquiry.entity';
import {
  InquiryCreateReqDto,
  InquiryGetDetailReqParamDto,
  InquiryGetListReqQueryDto,
  InquiryReplyReqDto,
} from '../api/inquiry.req.dto';
import { InquiryEntityTest } from '../../../test/infra/inquiry.entity.test';
import { UserEntityTest } from '../../../test/infra/user.entity.test';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { InquiryStatus } from '../interface/inquiry.status';
import { BadRequestException } from '@nestjs/common';
import { LoginUserInfoTest } from '../../../test/common/login.user.info.test';

describe('inquiry service test', () => {
  let sut: InquiryService;
  let inquiryRepository: any = mock<Repository<InquiryEntity>>();
  let queryBuilder = createMockQueryBuilder();

  beforeEach(async () => {
    queryBuilder = createMockQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InquiryService,
        {
          provide: getRepositoryToken(InquiryEntity),
          useValue: {
            ...inquiryRepository,
            ...createMockRepositoryMethod(),
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
      ],
    }).compile();

    sut = module.get<InquiryService>(InquiryService);
    inquiryRepository = module.get<Repository<InquiryEntity>>(getRepositoryToken(InquiryEntity));
  });

  describe('getList 조회 테스트', () => {
    it('조회에 성공한 경우', async () => {
      const givenGetQuery: InquiryGetListReqQueryDto = {
        page: 1,
        take: 2,
      };

      queryBuilder.getManyAndCount.mockResolvedValue([[{ ...InquiryEntityTest(), id: 1 }], 1]);

      const result = await sut.getList(givenGetQuery);

      expect(result.list[0].id).toBe(1);
      expect(result.totalPage).toBe(1);
      expect(result.totalCount).toBe(1);
      expect(result.currentPage).toBe(1);
    });
  });

  describe('getDetail 자세히보기 조회 테스트', () => {
    it('조회에 성공한 경우', async () => {
      const givenGetParamDto: InquiryGetDetailReqParamDto = {
        id: 1,
      };

      inquiryRepository.findOne.mockResolvedValue({
        ...InquiryEntityTest(),
        id: 1,
        filePath: 'test,test2',
        user: UserEntityTest(),
      });

      const result = await sut.getDetail(givenGetParamDto);

      expect(result.id).toBe(1);
      expect(result.filePath).toMatchObject(['test', 'test2']);
    });
  });

  describe('create 생성 테스트', () => {
    it('생성에 성공한 경우', async () => {
      const givenUser: ILoginUserInfo = {
        ...LoginUserInfoTest(),
        email: 'test@test.com',
        id: 1,
      };
      const givenGetBody: InquiryCreateReqDto = {
        content: '내용',
        filePathList: [],
        title: '제목',
      };

      await sut.create(givenUser, givenGetBody);

      expect(inquiryRepository.insert).toHaveBeenCalledWith({
        userId: 1,
        filePath: null,
        status: InquiryStatus.REGISTER,
        title: '제목',
        content: '내용',
      });
    });
  });

  describe('reply 문의 답변 테스트', () => {
    it('문의 답변에 성공한 경우', async () => {
      const givenUser: ILoginUserInfo = {
        ...LoginUserInfoTest(),
        id: 1,
        email: 'test@email.com',
      };
      const givenGetBody: InquiryReplyReqDto = {
        id: 1,
        replyContent: '답변',
      };

      inquiryRepository.findOne.mockResolvedValue({
        ...InquiryEntityTest(),
        id: 1,
      });
      await sut.reply(givenUser, givenGetBody);

      expect(inquiryRepository.save).toHaveBeenCalled();
    });

    it('해당 문의가 존재하지 않아 에러가 발생한 경우', async () => {
      const givenUser: ILoginUserInfo = {
        ...LoginUserInfoTest(),
        id: 1,
        email: 'test@email.com',
      };
      const givenGetBody: InquiryReplyReqDto = {
        id: 1,
        replyContent: '답변',
      };

      inquiryRepository.findOne.mockResolvedValue(null);

      await expect(async () => {
        await sut.reply(givenUser, givenGetBody);
      }).rejects.toThrow(new BadRequestException('1:1 문의가 존재하지 않습니다.'));
    });
  });
});
