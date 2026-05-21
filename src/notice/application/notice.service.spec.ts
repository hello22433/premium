import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { createMockQueryBuilder } from '../../common/test/mock.query.builder';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { NoticeService } from './notice.service';
import { NoticeEntity } from '../../entity/notice.entity';
import { NoticeCreateReqDto, NoticeGetListReqQueryDto, NoticeUpdateReqDto } from '../api/notice.req.dto';
import { NoticeEntityTest } from '../../../test/infra/notice.entity.test';
import { UserEntityTest } from '../../../test/infra/user.entity.test';
import { NoticePriority } from '../interface/notice.priority';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { LoginUserInfoTest } from '../../../test/common/login.user.info.test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { IUserAuthority } from '../../user/interface/user.authority';

describe('notice service test', () => {
  let sut: NoticeService;
  let noticeRepository: any = mock<Repository<NoticeEntity>>();
  let queryBuilder = createMockQueryBuilder();

  beforeEach(async () => {
    queryBuilder = createMockQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NoticeService,
        {
          provide: getRepositoryToken(NoticeEntity),
          useValue: {
            ...noticeRepository,
            ...createMockRepositoryMethod(),
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
      ],
    }).compile();

    sut = module.get<NoticeService>(NoticeService);
    noticeRepository = module.get<Repository<NoticeEntity>>(getRepositoryToken(NoticeEntity));
  });

  describe('getList 조회 테스트', () => {
    it('조회에 성공한 경우', async () => {
      const givenGetQuery: NoticeGetListReqQueryDto = {
        take: 10,
        page: 1,
      };

      queryBuilder.getManyAndCount.mockResolvedValue([
        [{ ...NoticeEntityTest(), id: 1, user: { ...UserEntityTest(), id: 1, personName: 'test', filePath: null } }],
        1,
      ]);
      const result = await sut.getList(givenGetQuery);

      expect(result.list[0].id).toBe(1);
      expect(result.list[0].isFile).toBeFalsy();
      expect(result.list[0].fileCount).toBe(0);
      expect(result.totalPage).toBe(1);
      expect(result.totalCount).toBe(1);
      expect(result.currentPage).toBe(1);
    });

    it('공지사항에 첨부 파일이 N 개 있을때 성공한 경우', async () => {
      const givenGetQuery: NoticeGetListReqQueryDto = {
        take: 10,
        page: 1,
      };

      queryBuilder.getManyAndCount.mockResolvedValue([
        [
          { ...NoticeEntityTest(), id: 1, filePath: null, user: { ...UserEntityTest(), id: 1, personName: 'test' } },
          {
            ...NoticeEntityTest(),
            id: 2,
            filePath: 'http://test.com,http://test2.com',
            user: { ...UserEntityTest(), id: 1, personName: 'test' },
          },
        ],
        2,
      ]);
      const result = await sut.getList(givenGetQuery);

      expect(result.list[0].id).toBe(1);
      expect(result.list[0].isFile).toBeFalsy();
      expect(result.list[0].fileCount).toBe(0);

      expect(result.list[1].id).toBe(2);
      expect(result.list[1].isFile).toBeTruthy();
      expect(result.list[1].fileCount).toBe(2);
      expect(result.totalPage).toBe(1);
      expect(result.totalCount).toBe(2);
      expect(result.currentPage).toBe(1);
    });
  });

  describe('create 테스트', () => {
    it('생성에 성공한 경우', async () => {
      const givenUser: ILoginUserInfo = LoginUserInfoTest();
      const givenGetBody: NoticeCreateReqDto = {
        title: '테스트',
        content: '테스트',
        priority: NoticePriority.LOW,
        filePath: [],
      };

      await sut.create(givenUser, givenGetBody);

      expect(noticeRepository.insert).toHaveBeenCalled();
    });
  });

  describe('update 테스트', () => {
    it('소유자가 수정에 성공한 경우', async () => {
      const givenUser: ILoginUserInfo = LoginUserInfoTest(); // id: 1, OPERATION_ADMIN
      const givenGetBody: NoticeUpdateReqDto = {
        id: 1,
        title: '테스트',
        content: '테스트',
        priority: NoticePriority.LOW,
        filePath: [],
      };
      const notice = { ...NoticeEntityTest(), id: 1, userId: 1 }; // userId matches user.id

      noticeRepository.findOne.mockResolvedValue(notice);

      await sut.update(givenUser, givenGetBody);

      expect(noticeRepository.save).toHaveBeenCalledWith(notice);
    });

    it('공지사항이 존재하지 않아 에러가 발생한 경우', async () => {
      const givenUser: ILoginUserInfo = LoginUserInfoTest();
      const givenGetBody: NoticeUpdateReqDto = {
        id: 1,
        title: '테스트',
        content: '테스트',
        priority: NoticePriority.LOW,
        filePath: [],
      };

      noticeRepository.findOne.mockResolvedValue(null);

      await expect(async () => {
        await sut.update(givenUser, givenGetBody);
      }).rejects.toThrow(new BadRequestException('공지사항이 존재하지 않습니다.'));
    });

    it('소유자가 아닌 OPERATION_ADMIN이 타인 공지 수정하면 ForbiddenException', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.OPERATION_ADMIN };
      const givenGetBody: NoticeUpdateReqDto = {
        id: 1,
        title: '테스트',
        content: '테스트',
        priority: NoticePriority.LOW,
        filePath: [],
      };

      noticeRepository.findOne.mockResolvedValue({ ...NoticeEntityTest(), id: 1, userId: 99 });

      await expect(sut.update(givenUser, givenGetBody)).rejects.toThrow(ForbiddenException);
    });

    it('SUPER_ADMIN은 타인 공지도 수정 가능', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.SUPER_ADMIN };
      const givenGetBody: NoticeUpdateReqDto = {
        id: 1,
        title: '테스트',
        content: '테스트',
        priority: NoticePriority.LOW,
        filePath: [],
      };
      const notice = { ...NoticeEntityTest(), id: 1, userId: 99 };

      noticeRepository.findOne.mockResolvedValue(notice);

      await sut.update(givenUser, givenGetBody);

      expect(noticeRepository.save).toHaveBeenCalled();
    });
  });

  describe('delete 보안 테스트', () => {
    it('소유자가 아닌 OPERATION_ADMIN이 타인 공지 삭제하면 ForbiddenException', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.OPERATION_ADMIN };

      noticeRepository.findOne.mockResolvedValue({ ...NoticeEntityTest(), id: 1, userId: 99 });

      await expect(sut.delete(givenUser, 1)).rejects.toThrow(ForbiddenException);
    });

    it('SUPER_ADMIN은 타인 공지도 삭제 가능', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.SUPER_ADMIN };

      noticeRepository.findOne.mockResolvedValue({ ...NoticeEntityTest(), id: 1, userId: 99 });

      await sut.delete(givenUser, 1);

      expect(noticeRepository.softDelete).toHaveBeenCalled();
    });

    it('소유자는 자신의 공지 삭제 가능', async () => {
      const givenUser: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, authority: IUserAuthority.OPERATION_ADMIN };

      noticeRepository.findOne.mockResolvedValue({ ...NoticeEntityTest(), id: 1, userId: 1 });

      await sut.delete(givenUser, 1);

      expect(noticeRepository.softDelete).toHaveBeenCalled();
    });
  });
});
