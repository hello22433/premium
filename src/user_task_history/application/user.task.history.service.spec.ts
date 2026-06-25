import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { UserTaskHistoryService } from './user.task.history.service';
import { UserTaskHistoryEntity } from '../../entity/user.task.history.entity';
import { UserEntity } from '../../entity/user.entity';
import { OrderEntity } from '../../entity/order.entity';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { createMockQueryBuilder } from '../../common/test/mock.query.builder';
import { IUserAuthority } from '../../user/interface/user.authority';
import { CryptoCipher } from '../../common/infra/crypto.cipher';

describe('UserTaskHistoryService', () => {
  let sut: UserTaskHistoryService;
  let userTaskHistoryRepository: any;
  let userRepository: any;
  let orderRepository: any;
  let queryBuilder: any;

  const CORPORATE_ADMIN_USER = { id: 5, email: 'corp@test.com', authority: IUserAuthority.CORPORATE_ADMIN };
  const OPERATION_ADMIN_USER = { id: 10, email: 'op@test.com', authority: IUserAuthority.OPERATION_ADMIN };
  const SUPER_ADMIN_USER = { id: 1, email: 'super@test.com', authority: IUserAuthority.SUPER_ADMIN };

  beforeEach(async () => {
    queryBuilder = createMockQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserTaskHistoryService,
        { provide: getRepositoryToken(UserTaskHistoryEntity), useValue: createMockRepositoryMethod() },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: { ...createMockRepositoryMethod(), createQueryBuilder: jest.fn(() => queryBuilder) },
        },
        { provide: getRepositoryToken(OrderEntity), useValue: createMockRepositoryMethod() },
        {
          provide: CryptoCipher,
          useValue: {
            encryptDeliveryTarget: jest.fn((v: string) => v),
            safeDecryptDeliveryTarget: jest.fn((v: string | null) => v),
          },
        },
      ],
    }).compile();

    sut = module.get<UserTaskHistoryService>(UserTaskHistoryService);
    userTaskHistoryRepository = module.get(getRepositoryToken(UserTaskHistoryEntity));
    userRepository = module.get(getRepositoryToken(UserEntity));
    orderRepository = module.get(getRepositoryToken(OrderEntity));
  });

  describe('getList 권한별 접근 제어', () => {
    it('CORPORATE_ADMIN → ForbiddenException', async () => {
      await expect(sut.getList(CORPORATE_ADMIN_USER, { page: 1, take: 10 })).rejects.toThrow(ForbiddenException);
    });

    it('OPERATION_ADMIN → DB 조회 진행', async () => {
      queryBuilder.getManyAndCount.mockResolvedValue([[], 0]);
      orderRepository.find.mockResolvedValue([]);

      const result = await sut.getList(OPERATION_ADMIN_USER, { page: 1, take: 10 });

      expect(result.list).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it('SUPER_ADMIN → DB 조회 진행', async () => {
      queryBuilder.getManyAndCount.mockResolvedValue([[], 0]);
      orderRepository.find.mockResolvedValue([]);

      const result = await sut.getList(SUPER_ADMIN_USER, { page: 1, take: 10 });

      expect(result.totalCount).toBe(0);
    });
  });

  describe('getList completionStatus 필터', () => {
    /**
     * mock QueryBuilder 는 실제 SQL 을 실행하지 않으므로, 여기서는 andWhere 에 넘어가는
     * SQL 문자열만 검증한다. 아래는 EXISTS 의 SQL 의미론으로 보장되며 단위 테스트로는 실증 불가:
     *   - soft-delete 된 이력만 있는 고객 → deleted_at IS NULL 조건이 0건 → INCOMPLETE
     *   - 한 고객의 이력이 복수여도 EXISTS 는 join 이 아니므로 목록 행/ totalCount 무중복
     * 위 두 acceptance 는 DB integration test 로만 실증 가능 (현 repo 는 전부 mock).
     */
    const findArgWith = (substr: string) =>
      queryBuilder.andWhere.mock.calls.find((args: any[]) => typeof args[0] === 'string' && args[0].includes(substr));

    beforeEach(() => {
      queryBuilder.getManyAndCount.mockResolvedValue([[], 0]);
      orderRepository.find.mockResolvedValue([]);
    });

    it('COMPLETED → 활성 상담이력 EXISTS 조건이 페이지네이션 전에 적용된다', async () => {
      await sut.getList(OPERATION_ADMIN_USER, { page: 1, take: 10, completionStatus: 'COMPLETED' });

      const call = findArgWith('EXISTS');
      expect(call).toBeDefined();
      expect(call[0]).toContain('user_task_history');
      expect(call[0]).toContain('deleted_at IS NULL');
      expect(call[0]).not.toContain('NOT EXISTS');
      // skip(=페이지네이션)보다 먼저 andWhere 호출
      const existsOrder = queryBuilder.andWhere.mock.invocationCallOrder.at(-1);
      const skipOrder = queryBuilder.skip.mock.invocationCallOrder.at(-1);
      expect(existsOrder).toBeLessThan(skipOrder);
    });

    it('INCOMPLETE → 활성 상담이력 NOT EXISTS 조건이 적용된다', async () => {
      await sut.getList(OPERATION_ADMIN_USER, { page: 1, take: 10, completionStatus: 'INCOMPLETE' });

      const call = findArgWith('NOT EXISTS');
      expect(call).toBeDefined();
      expect(call[0]).toContain('user_task_history');
      expect(call[0]).toContain('deleted_at IS NULL');
    });

    it('completionStatus 미전달 → EXISTS/NOT EXISTS 조건 미적용 (기존 동작 유지)', async () => {
      await sut.getList(OPERATION_ADMIN_USER, { page: 1, take: 10 });

      expect(findArgWith('EXISTS')).toBeUndefined();
    });
  });

  describe('getDetail 권한별 접근 제어', () => {
    it('CORPORATE_ADMIN → ForbiddenException', async () => {
      await expect(sut.getDetail(CORPORATE_ADMIN_USER, { id: 1 })).rejects.toThrow(ForbiddenException);
    });

    it('OPERATION_ADMIN + 유저 없음 → BadRequestException', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(sut.getDetail(OPERATION_ADMIN_USER, { id: 999 })).rejects.toThrow(
        new BadRequestException('유저가 존재하지 않습니다.'),
      );
    });

    it('OPERATION_ADMIN + 유저 존재 → 상담내역 반환', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 1,
        email: 'user@test.com',
        personName: '홍길동',
        personPhoneNumber: '010-1234-5678',
        personEmail: 'person@test.com',
        personCode: 'CODE',
        personCategory: null,
        businessGrade: null,
      });
      userTaskHistoryRepository.find.mockResolvedValue([]);
      userRepository.find.mockResolvedValue([]);

      const result = await sut.getDetail(OPERATION_ADMIN_USER, { id: 1 });

      expect(result.id).toBe(1);
      expect(result.list).toEqual([]);
    });

    it('SUPER_ADMIN + 유저 존재 → 상담내역 반환', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 1,
        email: 'user@test.com',
        personName: '홍길동',
        personPhoneNumber: '010-1234-5678',
        personEmail: 'person@test.com',
        personCode: 'CODE',
        personCategory: null,
        businessGrade: null,
      });
      userTaskHistoryRepository.find.mockResolvedValue([]);
      userRepository.find.mockResolvedValue([]);

      const result = await sut.getDetail(SUPER_ADMIN_USER, { id: 1 });

      expect(result.id).toBe(1);
      expect(result.list).toEqual([]);
    });
  });

  describe('create 권한별 접근 제어', () => {
    it('CORPORATE_ADMIN → ForbiddenException', async () => {
      await expect(sut.create(CORPORATE_ADMIN_USER, { userId: 1, content: '테스트' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('OPERATION_ADMIN → insert 호출, adminUserId는 loginUser.id', async () => {
      userTaskHistoryRepository.insert.mockResolvedValue({});

      await sut.create(OPERATION_ADMIN_USER, { userId: 1, content: '상담내역' });

      expect(userTaskHistoryRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, adminUserId: 10, content: '상담내역' }),
      );
    });

    it('SUPER_ADMIN → insert 호출, adminUserId는 loginUser.id', async () => {
      userTaskHistoryRepository.insert.mockResolvedValue({});

      await sut.create(SUPER_ADMIN_USER, { userId: 1, content: '상담내역' });

      expect(userTaskHistoryRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, adminUserId: 1, content: '상담내역' }),
      );
    });
  });

  describe('delete 권한별 접근 제어', () => {
    it('CORPORATE_ADMIN → ForbiddenException', async () => {
      await expect(sut.delete(CORPORATE_ADMIN_USER, { id: 1 })).rejects.toThrow(ForbiddenException);
    });

    it('OPERATION_ADMIN + 존재하지 않는 id → BadRequestException', async () => {
      userTaskHistoryRepository.findOne.mockResolvedValue(null);

      await expect(sut.delete(OPERATION_ADMIN_USER, { id: 999 })).rejects.toThrow(
        new BadRequestException('해당 상담내역을 찾을 수 없거나 이미 삭제되었습니다.'),
      );
    });

    it('OPERATION_ADMIN + 존재하는 id → softDelete 호출', async () => {
      userTaskHistoryRepository.findOne.mockResolvedValue({ id: 1 });
      userTaskHistoryRepository.softDelete.mockResolvedValue({});

      await sut.delete(OPERATION_ADMIN_USER, { id: 1 });

      expect(userTaskHistoryRepository.softDelete).toHaveBeenCalledWith({ id: 1 });
    });

    it('SUPER_ADMIN + 존재하는 id → softDelete 호출', async () => {
      userTaskHistoryRepository.findOne.mockResolvedValue({ id: 2 });
      userTaskHistoryRepository.softDelete.mockResolvedValue({});

      await sut.delete(SUPER_ADMIN_USER, { id: 2 });

      expect(userTaskHistoryRepository.softDelete).toHaveBeenCalledWith({ id: 2 });
    });
  });
});
