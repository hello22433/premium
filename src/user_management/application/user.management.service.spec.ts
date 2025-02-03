import { mock, mockReset } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user.entity';
import { UserManagementService } from './user.management.service';
import { createMockQueryBuilder } from '../../common/test/mock.query.builder';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import {
  UserManagementCreateReqDto,
  UserManagementGetListReqQueryDto,
  UserManagementUpdateReqDto,
} from '../api/user.management.req.dto';
import { UserEntityTest } from '../../../test/infra/user.entity.test';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../user/interface/user.settle.method';
import { BadRequestException } from '@nestjs/common';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserStatus } from '../../user/interface/user.status';
import { IUserBusinessType } from '../../user/interface/user.business.type';

describe('user management service test', () => {
  let userRepository: any = mock<Repository<UserEntity>>();
  let passwordEncrypt: any = mock<PasswordBcryptEncrypt>();
  let queryBuilder = createMockQueryBuilder();

  let sut: UserManagementService;

  beforeEach(async () => {
    queryBuilder = createMockQueryBuilder();
    mockReset(userRepository);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserManagementService,
        {
          provide: PasswordBcryptEncrypt,
          useValue: passwordEncrypt,
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: {
            ...userRepository,
            ...createMockRepositoryMethod(),
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
      ],
    }).compile();

    sut = module.get<UserManagementService>(UserManagementService);
    userRepository = module.get<Repository<UserEntity>>(getRepositoryToken(UserEntity));
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
      const givenGetBody: UserManagementCreateReqDto = {
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
      };
      userRepository.count.mockResolvedValue(0);

      await sut.create(givenGetBody);

      expect(userRepository.insert).toHaveBeenCalled();
      expect(passwordEncrypt.encrypt).toHaveBeenCalledWith('test1234');
    });

    it('중복된 이메일이 존재하여 계정 생성에 실패한 경우', async () => {
      const givenGetBody: UserManagementCreateReqDto = {
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
        await sut.create(givenGetBody);
      }).rejects.toThrow(new BadRequestException('중복된 이메일 입니다.'));
    });
  });

  describe('update 테스트', () => {
    it('업데이트에 성공한 경우 테스트', async () => {
      const givenUpdateBody: UserManagementUpdateReqDto = {
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
      };

      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        personName: 'Old Person',
        personPhoneNumber: '010-1111-2222',
        personEmail: 'oldperson@example.com',
        businessName: 'Old Business',
      });

      await sut.update(givenUpdateBody);

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
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
      const givenUpdateBody: UserManagementUpdateReqDto = {
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
      };

      userRepository.findOne.mockResolvedValue(null);

      await expect(async () => {
        await sut.update(givenUpdateBody);
      }).rejects.toThrow(new BadRequestException('유저가 존재하지 않습니다.'));

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
      });
      expect(userRepository.save).not.toHaveBeenCalled();
    });
  });
});
