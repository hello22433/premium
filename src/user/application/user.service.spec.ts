import { mock, MockProxy, mockReset } from 'jest-mock-extended';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { UserLoginByEmailPasswordReqDto, UserSignUpReqDto } from '../api/user.req.dto';
import { ILoginTokenValidator } from '../../auth/interface/login.token.validator';
import { BadRequestException, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { ILoginToken } from '../../auth/interface/token';
import { UserEntity } from '../../entity/user.entity';
import { Repository } from 'typeorm';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserEntityTest } from '../../../test/infra/user.entity.test';
import { UserService } from './user.service';
import { LoginUserInfoTest } from '../../../test/common/login.user.info.test';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { IMailSend } from '../../mail/interface/mail-send';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { UserViewScopeEntity } from '../../entity/user.view.scope.entity';
import { PasswordPolicyEntity } from '../../entity/password.policy.entity';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { DeliveryAlimTalk } from '../../delivery/interface/delivery.alim.talk';
import { ISmsSend } from '../../sms/interface/sms.send';
import { ConfigService } from '@nestjs/config';

jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => ({}),
}));

describe('user login service Test', () => {
  const userRepository: MockProxy<Repository<UserEntity>> = mock<Repository<UserEntity>>();
  const passwordEncrypt: MockProxy<PasswordBcryptEncrypt> = mock<PasswordBcryptEncrypt>();
  const loginTokenValidator: MockProxy<ILoginTokenValidator> = mock<ILoginTokenValidator>();
  const emailSendHistoryRepository: MockProxy<Repository<EmailSendHistoryEntity>> =
    mock<Repository<EmailSendHistoryEntity>>();
  const mailSendService: MockProxy<IMailSend> = mock<IMailSend>();
  const userCompanyRepository: MockProxy<Repository<UserCompanyEntity>> =
    mock<Repository<UserCompanyEntity>>();
  const userViewScopeRepository: MockProxy<Repository<UserViewScopeEntity>> =
    mock<Repository<UserViewScopeEntity>>();
  const passwordPolicyRepository: MockProxy<Repository<PasswordPolicyEntity>> =
    mock<Repository<PasswordPolicyEntity>>();
  const activityLogService: MockProxy<ActivityLogService> = mock<ActivityLogService>();
  const alimTalkService: MockProxy<DeliveryAlimTalk> = mock<DeliveryAlimTalk>();
  const smsSendService: MockProxy<ISmsSend> = mock<ISmsSend>();
  const configService: MockProxy<ConfigService> = mock<ConfigService>();

  const sut = new UserService(
    passwordEncrypt,
    loginTokenValidator,
    userRepository,
    userCompanyRepository,
    userViewScopeRepository,
    emailSendHistoryRepository,
    passwordPolicyRepository,
    mailSendService,
    alimTalkService,
    smsSendService,
    configService,
    activityLogService,
  );

  beforeEach(() => {
    mockReset(passwordEncrypt);
    mockReset(loginTokenValidator);
    mockReset(userRepository);
  });

  describe('isExistEmail 중복 이메일 테스트', () => {
    it('중복된 이메일이 존재할 경우 true', async () => {
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 0,
        email: 'test@gmail.com',
        password: 'PASSWORD',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      const result = await sut.isExistEmail('test@gmail.com');

      expect(result).toBeTruthy();
    });

    it('중복된 이메일이 존재하지 않을 경우 false', async () => {
      userRepository.findOne.mockResolvedValue(null);
      const result = await sut.isExistEmail('test@gmail.com');

      expect(result).toBeFalsy();
    });
  });

  describe('signUp 회원가입 테스트', () => {
    it('정보를 입력받아 회원가입에 성공한 경우', async () => {
      const givenSignUpDto: UserSignUpReqDto = {
        email: 'test@gmail.com',
        password: 'testset',
        personName: 'test',
        personPhoneNumber: '010-1234-5678',
        personEmail: 'test@gmail.com',
        businessType: null,
        corporateNumber: null,
        businessNumber: '1234567890',
        businessName: '테스트사업자',
        businessAddress: '서울시 강남구',
        businessPhoneNumber: '02-1234-5678',
        ip: '127.0.0.1',
        industryType: null,
        industryItem: null,
      };

      passwordEncrypt.encrypt.mockResolvedValue('테스트 패스워드');

      await sut.signUp(givenSignUpDto);

      expect(userRepository.insert).toHaveBeenCalledWith({
        email: 'test@gmail.com',
        password: '테스트 패스워드',
      });
    });
  });

  describe('loginByEmailPassword 로그인 테스트', () => {
    it('email password 를 입력받아 로그인이 성공하고 토큰이 발급된 경우', async () => {
      const givenLoginDto: UserLoginByEmailPasswordReqDto = {
        email: 'test@gmail.com',
        password: 'securePassword',
      };

      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 0,
        email: 'test@gmail.com',
        password: 'PASSWORD',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      passwordEncrypt.compare.mockResolvedValue(true);
      loginTokenValidator.issuance.mockReturnValue({
        accessToken: { value: 'token', expiredAt: '2024-09-16T00:00:00' },
        refreshToken: { value: 'token', expiredAt: '2024-09-16T00:00:00' },
      });

      const result = await sut.loginByEmailPassword(givenLoginDto, '127.0.0.1');

      expect(result.accessToken).toBeDefined();
      expect(result.accessToken!.value).toBe('token');
      expect(result.refreshToken).toBeDefined();
      expect(result.refreshToken!.value).toBe('token');
    });

    it('email의 유저가 존재하지 않는 경우', async () => {
      const givenLoginDto: UserLoginByEmailPasswordReqDto = {
        email: 'test@gmail.com',
        password: 'securePassword',
      };

      userRepository.findOne.mockResolvedValue(null);
      passwordEncrypt.compare.mockResolvedValue(true);
      loginTokenValidator.issuance.mockReturnValue({
        accessToken: { value: 'token', expiredAt: '2024-09-16T00:00:00' },
        refreshToken: { value: 'token', expiredAt: '2024-09-16T00:00:00' },
      });

      await expect(async () => {
        await sut.loginByEmailPassword(givenLoginDto, '127.0.0.1');
      }).rejects.toThrow(new BadRequestException('USER_DOES_NOT_EXIST'));
    });

    it('비밀번호가 일치하지 않는 경우', async () => {
      const givenLoginDto: UserLoginByEmailPasswordReqDto = {
        email: 'test@gmail.com',
        password: 'securePassword',
      };

      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 0,
        email: 'test@gmail.com',
        password: 'securePassword',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      passwordEncrypt.compare.mockResolvedValue(false);
      loginTokenValidator.issuance.mockReturnValue({
        accessToken: { value: 'token', expiredAt: '2024-09-16T00:00:00' },
        refreshToken: { value: 'token', expiredAt: '2024-09-16T00:00:00' },
      });

      await expect(async () => {
        await sut.loginByEmailPassword(givenLoginDto, '127.0.0.1');
      }).rejects.toThrow(new BadRequestException('USER_DO_NOT_MATCH_PASSWORD'));
    });
  });

  describe('getAccessByRefresh refresh token 으로 access token 재발급 하기 테스트', () => {
    it('refresh token 값을 입력받아 올바르게 access token이 발급된 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';
      const givenUserInfo: ILoginUserInfo = {
        ...LoginUserInfoTest(),
        id: 1,
        email: 'test@gmail.com',
      };
      const givenToken: ILoginToken = {
        accessToken: { value: 'token', expiredAt: '2024-09-16T00:00:00' },
        refreshToken: { value: 'token', expiredAt: '2024-09-16T00:00:00' },
      };

      loginTokenValidator.validateByToken.calledWith(givenTokenString).mockReturnValue(givenUserInfo);

      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 0,
        email: 'test@gmail.com',
        password: 'securePassword',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      loginTokenValidator.issuance.calledWith(givenUserInfo).mockReturnValue(givenToken);

      const result = await sut.getAccessByRefresh(givenTokenString);

      expect(result.accessToken).toBeDefined();
    });

    it('refresh token 의 유저가 데이터베이스에 존재하지 않을 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';
      const givenUserInfo: ILoginUserInfo = {
        ...LoginUserInfoTest(),
        id: 1,
        email: 'test@gmail.com',
      };

      loginTokenValidator.validateByToken.calledWith(givenTokenString).mockReturnValue(givenUserInfo);

      userRepository.findOne.mockResolvedValue(null);

      await expect(async () => {
        await sut.getAccessByRefresh(givenTokenString);
      }).rejects.toThrow(new BadRequestException('USER_DOES_NOT_EXIST'));
    });

    it('refresh token 이 만료 된 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';

      loginTokenValidator.validateByToken.calledWith(givenTokenString).mockImplementation(() => {
        throw new Error('토큰만료');
      });

      await expect(async () => {
        await sut.getAccessByRefresh(givenTokenString);
      }).rejects.toThrow(new Error('토큰만료'));
    });

    it('refresh token 이 올바르지 않을 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';

      loginTokenValidator.validateByToken.calledWith(givenTokenString).mockImplementation(() => {
        throw new Error('토큰 에러');
      });

      await expect(async () => {
        await sut.getAccessByRefresh(givenTokenString);
      }).rejects.toThrow(new Error('토큰 에러'));
    });
  });

  describe('getLoginTokenByRefresh refresh token 으로 로그인 토큰 재발급 하기 테스트', () => {
    it('refresh token 값을 입력받아 올바르게 access token이 발급된 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';
      const givenUserInfo: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, email: 'test@gmail.com' };
      const givenToken: ILoginToken = {
        accessToken: { value: 'token', expiredAt: '2024-09-16T00:00:00' },
        refreshToken: { value: 'token', expiredAt: '2024-09-16T00:00:00' },
      };

      loginTokenValidator.validateByToken.calledWith(givenTokenString).mockReturnValue(givenUserInfo);
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 0,
        email: 'test@gmail.com',
        password: 'securePassword',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      loginTokenValidator.issuance.calledWith(givenUserInfo).mockReturnValue(givenToken);

      const result = await sut.getLoginTokenByRefresh(givenTokenString);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });

    it('refresh token 의 유저가 데이터베이스에 존재하지 않을 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';
      const givenUserInfo: ILoginUserInfo = {
        ...LoginUserInfoTest(),
        id: 1,
        email: 'test@gmail.com',
      };

      loginTokenValidator.validateByToken.calledWith(givenTokenString).mockReturnValue(givenUserInfo);

      userRepository.findOne.mockResolvedValue(null);

      await expect(async () => {
        await sut.getLoginTokenByRefresh(givenTokenString);
      }).rejects.toThrow(new InternalServerErrorException('USER_DOES_NOT_EXIST'));
    });

    it('refresh token 이 만료 된 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';

      loginTokenValidator.validateByToken.calledWith(givenTokenString).mockImplementation(() => {
        throw new UnauthorizedException('expired token');
      });

      await expect(async () => {
        await sut.getLoginTokenByRefresh(givenTokenString);
      }).rejects.toThrow(new UnauthorizedException('expired token'));
    });

    it('refresh token 이 올바르지 않을 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';

      loginTokenValidator.validateByToken.calledWith(givenTokenString).mockImplementation(() => {
        throw new UnauthorizedException('token error');
      });

      await expect(async () => {
        await sut.getLoginTokenByRefresh(givenTokenString);
      }).rejects.toThrow(new UnauthorizedException('token error'));
    });
  });
});
