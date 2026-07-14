import { mock, MockProxy, mockReset } from 'jest-mock-extended';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { UserLoginByEmailPasswordReqDto, UserSignUpReqDto } from '../api/user.req.dto';
import { ILoginTokenValidator } from '../../auth/interface/login.token.validator';
import { InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
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
import { AuthException } from '../exception/auth.exception';
import { AuthErrorCode } from '../exception/auth-error-code';
import { IUserStatus } from '../interface/user.status';
import { AccountStatusTransitionService } from '../../account_lifecycle/application/account.status.transition.service';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { SettlementCodeAdminService } from '../../wallet/application/settlement-code-admin.service';

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
  const userCompanyRepository: MockProxy<Repository<UserCompanyEntity>> = mock<Repository<UserCompanyEntity>>();
  const userViewScopeRepository: MockProxy<Repository<UserViewScopeEntity>> = mock<Repository<UserViewScopeEntity>>();
  const passwordPolicyRepository: MockProxy<Repository<PasswordPolicyEntity>> =
    mock<Repository<PasswordPolicyEntity>>();
  const activityLogService: MockProxy<ActivityLogService> = mock<ActivityLogService>();
  const alimTalkService: MockProxy<DeliveryAlimTalk> = mock<DeliveryAlimTalk>();
  const smsSendService: MockProxy<ISmsSend> = mock<ISmsSend>();
  const configService: MockProxy<ConfigService> = mock<ConfigService>();
  const accountStatusTransitionService: MockProxy<AccountStatusTransitionService> =
    mock<AccountStatusTransitionService>();
  const cryptoCipher: MockProxy<CryptoCipher> = mock<CryptoCipher>();
  const settlementCodeAdminService: MockProxy<SettlementCodeAdminService> = mock<SettlementCodeAdminService>();

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
    accountStatusTransitionService,
    cryptoCipher,
    settlementCodeAdminService,
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
    const baseDto = (): UserSignUpReqDto => ({
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
    });

    beforeEach(() => {
      mockReset(userCompanyRepository);
      mockReset(userViewScopeRepository);
      mockReset(accountStatusTransitionService);
      mockReset(settlementCodeAdminService);
      passwordEncrypt.encrypt.mockResolvedValue('테스트 패스워드');
      userRepository.insert.mockResolvedValue({ identifiers: [{ id: 7 }] } as any);
    });

    it('신규 회사(NEW) → 공유 wallet 프로비저닝(POST_PAYMENT/CARD) + settlement_code=company-{id} 배정', async () => {
      userCompanyRepository.findOne.mockResolvedValue(null);
      userCompanyRepository.save.mockResolvedValue({ id: 42, maximumLimit: 5000 } as any);
      settlementCodeAdminService.classifyJoin.mockResolvedValue({ mode: 'NEW', code: 'company-42' });

      await sut.signUp(baseDto());

      expect(settlementCodeAdminService.classifyJoin).toHaveBeenCalledWith(42, true);
      expect(settlementCodeAdminService.ensureSettlementCodeWallet).toHaveBeenCalledWith(
        42,
        'company-42',
        5000,
        expect.anything(),
        'POST_PAYMENT',
        'CARD',
      );
      expect(userRepository.update).toHaveBeenCalledWith(7, { settlementCode: 'company-42' });
    });

    it('기존 회사 단일 코드(SHARE_ONE) → wallet 생성 없이 기존 코드 공유', async () => {
      userCompanyRepository.findOne.mockResolvedValue({ id: 42, maximumLimit: 5000 } as any);
      settlementCodeAdminService.classifyJoin.mockResolvedValue({ mode: 'SHARE_ONE', code: 'company-42' });

      await sut.signUp(baseDto());

      expect(settlementCodeAdminService.classifyJoin).toHaveBeenCalledWith(42, false);
      expect(settlementCodeAdminService.ensureSettlementCodeWallet).not.toHaveBeenCalled();
      expect(userRepository.update).toHaveBeenCalledWith(7, { settlementCode: 'company-42' });
    });

    it('배정 대기(PENDING) → wallet 생성/코드 배정 없음 (빈 code 유지)', async () => {
      userCompanyRepository.findOne.mockResolvedValue({ id: 42, maximumLimit: 5000 } as any);
      settlementCodeAdminService.classifyJoin.mockResolvedValue({ mode: 'PENDING' });

      await sut.signUp(baseDto());

      expect(settlementCodeAdminService.ensureSettlementCodeWallet).not.toHaveBeenCalled();
      expect(userRepository.update).not.toHaveBeenCalled();
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
        ip: '127.0.0.1',
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
      }).rejects.toThrow(new AuthException(AuthErrorCode.USER_NOT_FOUND));
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
      }).rejects.toThrow(new AuthException(AuthErrorCode.INVALID_PASSWORD));
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

      loginTokenValidator.validateByToken.calledWith(givenTokenString, 'refresh').mockReturnValue(givenUserInfo);
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: givenUserInfo.id,
        email: givenUserInfo.email,
        authority: givenUserInfo.authority,
        password: 'securePassword',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      loginTokenValidator.issuance.mockReturnValue(givenToken);

      const result = await sut.getLoginTokenByRefresh(givenTokenString);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(loginTokenValidator.issuance).toHaveBeenCalledWith(givenUserInfo);
    });

    it('refresh token 의 유저가 데이터베이스에 존재하지 않을 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';
      const givenUserInfo: ILoginUserInfo = {
        ...LoginUserInfoTest(),
        id: 1,
        email: 'test@gmail.com',
      };

      loginTokenValidator.validateByToken.calledWith(givenTokenString, 'refresh').mockReturnValue(givenUserInfo);

      userRepository.findOne.mockResolvedValue(null);

      await expect(async () => {
        await sut.getLoginTokenByRefresh(givenTokenString);
      }).rejects.toThrow(new InternalServerErrorException('USER_DOES_NOT_EXIST'));
    });

    it('refresh token 이 만료 된 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';

      loginTokenValidator.validateByToken.calledWith(givenTokenString, 'refresh').mockImplementation(() => {
        throw new UnauthorizedException('expired token');
      });

      await expect(async () => {
        await sut.getLoginTokenByRefresh(givenTokenString);
      }).rejects.toThrow(new UnauthorizedException('expired token'));
    });

    it('refresh token 이 올바르지 않을 경우', async () => {
      const givenTokenString = 'GIVEN_TOKEN';

      loginTokenValidator.validateByToken.calledWith(givenTokenString, 'refresh').mockImplementation(() => {
        throw new UnauthorizedException('token error');
      });

      await expect(async () => {
        await sut.getLoginTokenByRefresh(givenTokenString);
      }).rejects.toThrow(new UnauthorizedException('token error'));
    });

    const gateCases: {
      label: string;
      status?: IUserStatus;
      isLoginLocked?: boolean;
      errorCode: (typeof AuthErrorCode)[keyof typeof AuthErrorCode];
    }[] = [
      { label: '로그인 잠금 계정', isLoginLocked: true, errorCode: AuthErrorCode.ACCOUNT_LOCKED },
      { label: '미승인 계정', status: IUserStatus.NOT_APPROVED, errorCode: AuthErrorCode.USER_NOT_APPROVED },
      { label: '휴면 계정', status: IUserStatus.NOT_USED, errorCode: AuthErrorCode.ACCOUNT_SUSPENDED },
      { label: '탈퇴 계정', status: IUserStatus.LEAVE, errorCode: AuthErrorCode.ACCOUNT_WITHDRAWN },
    ];

    gateCases.forEach(({ label, status, isLoginLocked, errorCode }) => {
      it(`${label}은 재발급을 거부한다`, async () => {
        const givenTokenString = 'GIVEN_TOKEN';
        const givenUserInfo: ILoginUserInfo = { ...LoginUserInfoTest(), id: 1, email: 'test@gmail.com' };

        loginTokenValidator.validateByToken.calledWith(givenTokenString, 'refresh').mockReturnValue(givenUserInfo);
        userRepository.findOne.mockResolvedValue({
          ...UserEntityTest(),
          id: 1,
          email: 'test@gmail.com',
          status: status ?? IUserStatus.USED,
          isLoginLocked: isLoginLocked ?? false,
        });

        await expect(async () => {
          await sut.getLoginTokenByRefresh(givenTokenString);
        }).rejects.toThrow(new AuthException(errorCode));

        expect(loginTokenValidator.issuance).not.toHaveBeenCalled();
      });
    });
  });

  describe('reactivateEmailSend 휴면 재활성화 이메일 발송', () => {
    beforeEach(() => {
      mockReset(userRepository);
      mockReset(emailSendHistoryRepository);
      mockReset(mailSendService);
      mockReset(cryptoCipher);
      mockReset(accountStatusTransitionService);
      cryptoCipher.encryptDeliveryTarget.mockReturnValue('ENC');
      emailSendHistoryRepository.save.mockImplementation((e: any) => {
        e.id = 55;
        return Promise.resolve(e);
      });
    });

    const dormantUser = (personEmail: string) => ({
      ...UserEntityTest(),
      id: 9,
      email: 'account@enmad.com',
      status: IUserStatus.NOT_USED,
      personEmail,
    });

    it('휴면 상태가 아니면(USED) REACTIVATION_NOT_ALLOWED', async () => {
      userRepository.findOne.mockResolvedValue({ ...dormantUser(''), status: IUserStatus.USED });
      await expect(sut.reactivateEmailSend({ email: 'account@enmad.com' } as any)).rejects.toThrow(
        new AuthException(AuthErrorCode.REACTIVATION_NOT_ALLOWED),
      );
      expect(mailSendService.send).not.toHaveBeenCalled();
    });

    it('탈퇴(LEAVE) 계정은 ACCOUNT_WITHDRAWN', async () => {
      userRepository.findOne.mockResolvedValue({ ...dormantUser(''), status: IUserStatus.LEAVE });
      await expect(sut.reactivateEmailSend({ email: 'account@enmad.com' } as any)).rejects.toThrow(
        new AuthException(AuthErrorCode.ACCOUNT_WITHDRAWN),
      );
      expect(mailSendService.send).not.toHaveBeenCalled();
    });

    it('담당자 이메일 1개 이하면 계정 이메일로 즉시 발송(needEmailSelection=false)', async () => {
      userRepository.findOne.mockResolvedValue(dormantUser('manager@enmad.com'));
      const res = await sut.reactivateEmailSend({ email: 'account@enmad.com' } as any);

      expect(res).toEqual({ needEmailSelection: false, id: 55, candidates: [] });
      expect(mailSendService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'account@enmad.com' }));
    });

    it('담당자 이메일 2개 + index 미지정 → 마스킹 후보 반환, 발송 보류', async () => {
      userRepository.findOne.mockResolvedValue(dormantUser('manager1@enmad.com,second@enmad.com'));
      const res = await sut.reactivateEmailSend({ email: 'account@enmad.com' } as any);

      expect(res.needEmailSelection).toBe(true);
      expect(res.id).toBeNull();
      expect(res.candidates).toEqual([
        { index: 0, maskedEmail: 'ma****r1@enmad.com' },
        { index: 1, maskedEmail: 'se****nd@enmad.com' },
      ]);
      expect(mailSendService.send).not.toHaveBeenCalled();
    });

    it('담당자 이메일 2개 + index 지정 → 선택한 이메일로 발송', async () => {
      userRepository.findOne.mockResolvedValue(dormantUser('manager1@enmad.com,second@enmad.com'));
      const res = await sut.reactivateEmailSend({ email: 'account@enmad.com', targetEmailIndex: 1 } as any);

      expect(res).toEqual({ needEmailSelection: false, id: 55, candidates: [] });
      expect(mailSendService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'second@enmad.com' }));
    });

    it('index 범위 초과 → INVALID_TARGET_EMAIL', async () => {
      userRepository.findOne.mockResolvedValue(dormantUser('manager1@enmad.com,second@enmad.com'));
      await expect(
        sut.reactivateEmailSend({ email: 'account@enmad.com', targetEmailIndex: 2 } as any),
      ).rejects.toThrow(new AuthException(AuthErrorCode.INVALID_TARGET_EMAIL));
      expect(mailSendService.send).not.toHaveBeenCalled();
    });

    it('index 가 null 이면(검증 우회) 후보 반환 + 발송 보류', async () => {
      userRepository.findOne.mockResolvedValue(dormantUser('manager1@enmad.com,second@enmad.com'));
      const res = await sut.reactivateEmailSend({ email: 'account@enmad.com', targetEmailIndex: null } as any);

      expect(res.needEmailSelection).toBe(true);
      expect(res.id).toBeNull();
      expect(mailSendService.send).not.toHaveBeenCalled();
    });

    it.each([
      ['소수', 0.5],
      ['음수', -1],
    ])('index 가 %s(%p)면 INVALID_TARGET_EMAIL', async (_label, idx) => {
      userRepository.findOne.mockResolvedValue(dormantUser('manager1@enmad.com,second@enmad.com'));
      await expect(
        sut.reactivateEmailSend({ email: 'account@enmad.com', targetEmailIndex: idx } as any),
      ).rejects.toThrow(new AuthException(AuthErrorCode.INVALID_TARGET_EMAIL));
      expect(mailSendService.send).not.toHaveBeenCalled();
    });
  });
});
