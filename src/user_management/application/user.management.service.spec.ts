import { mock, mockReset } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { UserViewScopeEntity } from '../../entity/user.view.scope.entity';
import { DepartmentEntity } from '../../entity/department.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { ExternalApiAllowedIpEntity } from '../../entity/external.api.allowed.ip.entity';
import { ExternalApiSsgRequestEntity } from '../../entity/external.api.ssg.request.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { UserManagementService } from './user.management.service';
import { createMockQueryBuilder } from '../../common/test/mock.query.builder';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import {
  UserManagementGetListReqQueryDto,
  UserManagementModifyMaximumLimitReqDto,
} from '../api/user.management.req.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UserEntityTest } from '../../../test/infra/user.entity.test';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../user/interface/user.settle.method';
import { BadRequestException } from '@nestjs/common';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserStatus } from '../../user/interface/user.status';
import { IUserBusinessType } from '../../user/interface/user.business.type';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ConfigService } from '@nestjs/config';

describe('user management service test', () => {
  let userRepository: any = mock<Repository<UserEntity>>();
  let userCompanyRepository: any;
  let passwordEncrypt: any = mock<PasswordBcryptEncrypt>();
  let queryBuilder = createMockQueryBuilder();

  let sut: UserManagementService;

  const CORPORATE_ADMIN_USER = { id: 5, email: 'corp@test.com', authority: IUserAuthority.CORPORATE_ADMIN };
  const OPERATION_ADMIN_USER = { id: 10, email: 'op@test.com', authority: IUserAuthority.OPERATION_ADMIN };
  const SUPER_ADMIN_USER = { id: 1, email: 'super@test.com', authority: IUserAuthority.SUPER_ADMIN };

  beforeEach(async () => {
    queryBuilder = createMockQueryBuilder();
    mockReset(userRepository);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserManagementService,
        { provide: PasswordBcryptEncrypt, useValue: passwordEncrypt },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: {
            ...userRepository,
            ...createMockRepositoryMethod(),
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
        {
          provide: getRepositoryToken(UserCompanyEntity),
          useValue: { ...createMockRepositoryMethod(), createQueryBuilder: jest.fn(() => queryBuilder) },
        },
        { provide: getRepositoryToken(UserViewScopeEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(DepartmentEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiAccountEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiAllowedIpEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiSsgRequestEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(WalletAccountEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(WalletTransactionEntity), useValue: createMockRepositoryMethod() },
        { provide: 'IMailSend', useValue: { send: jest.fn() } },
        { provide: 'DeliveryAlimTalk', useValue: { send: jest.fn() } },
        { provide: 'ISmsSend', useValue: { send: jest.fn() } },
        {
          provide: ActivityLogService,
          useValue: {
            createLog: jest.fn(),
            getBalanceHistoryByUserId: jest.fn(),
            getMaximumLimitHistoryByUserId: jest.fn(),
          },
        },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('TEMPLATE_CODE') } },
      ],
    }).compile();

    sut = module.get<UserManagementService>(UserManagementService);
    userRepository = module.get<Repository<UserEntity>>(getRepositoryToken(UserEntity));
    userCompanyRepository = module.get(getRepositoryToken(UserCompanyEntity));
    passwordEncrypt = module.get<PasswordBcryptEncrypt>(PasswordBcryptEncrypt);
  });

  describe('getList 리스트 조회 테스트', () => {
    it('성공적으로 조회한 경우', async () => {
      const givenGetBody: UserManagementGetListReqQueryDto = {
        page: 1,
        take: 10,
      };

      queryBuilder.getManyAndCount.mockResolvedValue([[{ ...UserEntityTest(), id: 1 }], 1]);

      const result = await sut.getList(givenGetBody);

      expect(result.list[0].id).toBe(1);
      expect(result.totalPage).toBe(1);
      expect(result.totalCount).toBe(1);
    });
  });

  describe('create 유저 생성 테스트', () => {
    it('생성에 성공한 경우', async () => {
      const givenGetBody = {
        bankName: '',
        bankNumber: '',
        businessAddress: '',
        businessName: '',
        businessNumber: '',
        businessPhoneNumber: '',
        cardName: '',
        cardNumber: '',
        corporateNumber: null,
        email: '',
        ip: null,
        maximumLimit: 0,
        password: 'test1234',
        personEmail: '',
        personName: '',
        personPhoneNumber: '',
        settleCondition: IUserSettleCondition.POST_PAYMENT,
        settleMethod: IUserSettleMethod.CARD,
        authority: IUserAuthority.SUPER_ADMIN,
        businessType: IUserBusinessType.CORPORATE,
        authorityList: [],
        allowedSendMethods: [],
      };
      userRepository.count.mockResolvedValue(0);
      userRepository.insert.mockResolvedValue({ identifiers: [{ id: 1 }] });

      await sut.create(givenGetBody as any);

      expect(userRepository.insert).toHaveBeenCalled();
      expect(passwordEncrypt.encrypt).toHaveBeenCalledWith('test1234');
    });

    it('중복된 이메일이 존재하여 계정 생성에 실패한 경우', async () => {
      const givenGetBody = {
        bankName: '',
        bankNumber: '',
        businessAddress: '',
        businessName: '',
        businessNumber: '',
        businessPhoneNumber: '',
        cardName: '',
        cardNumber: '',
        corporateNumber: null,
        email: '',
        ip: null,
        maximumLimit: 0,
        password: 'test1234',
        personEmail: '',
        personName: '',
        personPhoneNumber: '',
        settleCondition: IUserSettleCondition.POST_PAYMENT,
        settleMethod: IUserSettleMethod.CARD,
        authority: IUserAuthority.CORPORATE_ADMIN,
        businessType: IUserBusinessType.CORPORATE,
      };
      userRepository.count.mockResolvedValue(1);

      await expect(async () => {
        await sut.create(givenGetBody as any);
      }).rejects.toThrow(new BadRequestException('중복된 이메일 입니다.'));
    });
  });

  describe('update 테스트', () => {
    it('업데이트에 성공한 경우 테스트', async () => {
      const givenUpdateBody = {
        id: 1,
        bankName: 'New Bank',
        bankNumber: '123-456-789',
        businessAddress: 'New Address',
        businessName: 'Updated Business',
        businessNumber: '1234567890',
        businessPhoneNumber: '010-1234-5678',
        cardName: 'Updated Card',
        cardNumber: '9876-5432-1098-7654',
        corporateNumber: '123456-7890123',
        ip: '192.168.0.1',
        maximumLimit: 1000000,
        personEmail: 'person@example.com',
        personName: 'Updated Person',
        personPhoneNumber: '010-9876-5432',
        settleCondition: IUserSettleCondition.POST_PAYMENT,
        settleMethod: IUserSettleMethod.CARD,
        authority: IUserAuthority.SUPER_ADMIN,
        status: IUserStatus.USED,
        businessType: IUserBusinessType.CORPORATE,
        authorityList: [],
        allowedSendMethods: [],
      };

      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        personName: 'Old Person',
        personPhoneNumber: '010-1111-2222',
        personEmail: 'oldperson@example.com',
      });
      userCompanyRepository.findOne.mockResolvedValue({ id: 10, businessNumber: '1234567890' });

      await sut.update(givenUpdateBody as any);

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
        relations: ['company'],
      });
      expect(userRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          personName: 'Updated Person',
          personPhoneNumber: '010-9876-5432',
          // businessName: 'Updated Business',
        }),
      );
    });

    it('user 가 없어 실패한 경우', async () => {
      const givenUpdateBody = {
        id: 1,
        bankName: 'New Bank',
        bankNumber: '123-456-789',
        businessAddress: 'New Address',
        businessName: 'Updated Business',
        businessNumber: '1234567890',
        businessPhoneNumber: '010-1234-5678',
        cardName: 'Updated Card',
        cardNumber: '9876-5432-1098-7654',
        corporateNumber: '123456-7890123',
        ip: '192.168.0.1',
        maximumLimit: 1000000,
        personEmail: 'person@example.com',
        personName: 'Updated Person',
        personPhoneNumber: '010-9876-5432',
        settleCondition: IUserSettleCondition.POST_PAYMENT,
        settleMethod: IUserSettleMethod.CARD,
        authority: IUserAuthority.SUPER_ADMIN,
        status: IUserStatus.USED,
        businessType: IUserBusinessType.CORPORATE,
        authorityList: [],
        allowedSendMethods: [],
      };

      userRepository.findOne.mockResolvedValue(null);

      await expect(async () => {
        await sut.update(givenUpdateBody as any);
      }).rejects.toThrow(new BadRequestException('유저가 존재하지 않습니다.'));

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
        relations: ['company'],
      });
      expect(userRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('getCompanyList 권한별 필터 테스트', () => {
    it('CORPORATE_ADMIN: own companyId 필터 적용', async () => {
      userRepository.findOne.mockResolvedValue({ companyId: 10 });

      await sut.getCompanyList({ page: 1, take: 10 }, CORPORATE_ADMIN_USER);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('company.id = :companyId', { companyId: 10 });
    });

    it('CORPORATE_ADMIN: businessName 검색 시 companyId + businessName 필터 모두 적용', async () => {
      userRepository.findOne.mockResolvedValue({ companyId: 10 });

      await sut.getCompanyList({ page: 1, take: 10, businessName: '테스트' }, CORPORATE_ADMIN_USER);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('company.id = :companyId', { companyId: 10 });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('company.businessName LIKE :businessName', {
        businessName: '%테스트%',
      });
    });

    it('OPERATION_ADMIN: companyId 필터 없음', async () => {
      await sut.getCompanyList({ page: 1, take: 10 }, OPERATION_ADMIN_USER);

      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('company.id = :companyId', expect.anything());
    });

    it('SUPER_ADMIN: companyId 필터 없음', async () => {
      await sut.getCompanyList({ page: 1, take: 10 }, SUPER_ADMIN_USER);

      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('company.id = :companyId', expect.anything());
    });
  });

  describe('getNameList 권한별 필터 테스트', () => {
    it('CORPORATE_ADMIN: 자기 id로만 필터링', async () => {
      await sut.getNameList({}, CORPORATE_ADMIN_USER);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('user.id = :id', { id: 5 });
    });

    it('OPERATION_ADMIN: 전체 조회, user.id 필터 없음', async () => {
      await sut.getNameList({}, OPERATION_ADMIN_USER);

      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('user.id = :id', expect.anything());
    });

    it('SUPER_ADMIN: 전체 조회, user.id 필터 없음', async () => {
      await sut.getNameList({}, SUPER_ADMIN_USER);

      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('user.id = :id', expect.anything());
    });
  });
});

describe('UserManagementModifyMaximumLimitReqDto 검증 테스트', () => {
  it('newMaximumLimit 음수 입력 시 유효성 검사 오류 반환', async () => {
    const dto = plainToInstance(UserManagementModifyMaximumLimitReqDto, { id: 1, newMaximumLimit: -1 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newMaximumLimit')).toBe(true);
  });

  it('newMaximumLimit 0 입력 시 유효성 검사 통과', async () => {
    const dto = plainToInstance(UserManagementModifyMaximumLimitReqDto, { id: 1, newMaximumLimit: 0 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newMaximumLimit')).toBe(false);
  });

  it('newMaximumLimit 소수점 입력 시 유효성 검사 오류 반환', async () => {
    const dto = plainToInstance(UserManagementModifyMaximumLimitReqDto, { id: 1, newMaximumLimit: 1.5 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newMaximumLimit')).toBe(true);
  });

  it('newMaximumLimit MYSQL_INT_MAX 초과 입력 시 유효성 검사 오류 반환', async () => {
    const dto = plainToInstance(UserManagementModifyMaximumLimitReqDto, { id: 1, newMaximumLimit: 2_147_483_648 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newMaximumLimit')).toBe(true);
  });
});
