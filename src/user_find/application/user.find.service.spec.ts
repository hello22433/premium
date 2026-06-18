import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { UserFindService } from './user.find.service';
import { UserEntity } from '../../entity/user.entity';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { EmailType } from '../../mail/domain/email.type';
import { LoginVerifyMethod } from '../../user/interface/login.verify.method';
import { ConfigService } from '@nestjs/config';
import { CryptoCipher } from '../../common/infra/crypto.cipher';

describe('UserFindService', () => {
  let sut: UserFindService;
  let userRepository: any;
  let emailSendHistoryRepository: any;
  let passwordEncrypt: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserFindService,
        { provide: getRepositoryToken(UserEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(EmailSendHistoryEntity), useValue: createMockRepositoryMethod() },
        { provide: 'IMailSend', useValue: { send: jest.fn() } },
        { provide: PasswordBcryptEncrypt, useValue: { encrypt: jest.fn().mockResolvedValue('hashed') } },
        { provide: 'DeliveryAlimTalk', useValue: { send: jest.fn() } },
        { provide: 'ISmsSend', useValue: { send: jest.fn() } },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('TEMPLATE_CODE') } },
        { provide: CryptoCipher, useValue: { encryptDeliveryTarget: jest.fn((v: string) => v) } },
      ],
    }).compile();

    sut = module.get<UserFindService>(UserFindService);
    userRepository = module.get(getRepositoryToken(UserEntity));
    emailSendHistoryRepository = module.get(getRepositoryToken(EmailSendHistoryEntity));
    passwordEncrypt = module.get(PasswordBcryptEncrypt);
  });

  describe('resetPasswordSend — userId 바인딩', () => {
    it('유저 조회 성공 시 history에 userId 저장', async () => {
      const givenUser = { id: 42, email: 'user@test.com', personPhoneNumber: '010-0000-0000', loginVerifyMethod: LoginVerifyMethod.EMAIL };
      userRepository.findOne.mockResolvedValue(givenUser);
      emailSendHistoryRepository.save.mockResolvedValue({ id: 1 });

      await sut.resetPasswordSend({
        email: 'user@test.com',
        businessNumber: '1234567890',
        personName: '홍길동',
        personPhoneNumber: '010-0000-0000',
      });

      expect(emailSendHistoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 42 }),
      );
    });
  });

  describe('resetPasswordVerify — userId 교차 검증', () => {
    it('history 없음 → BadRequestException', async () => {
      emailSendHistoryRepository.findOne.mockResolvedValue(null);

      await expect(sut.resetPasswordVerify({ id: 1, code: 'ABC123' })).rejects.toThrow(
        new BadRequestException('인증 데이터가 없습니다.'),
      );
    });

    it('history.userId가 null → BadRequestException (구 레코드 방어)', async () => {
      emailSendHistoryRepository.findOne.mockResolvedValue({
        id: 1,
        type: EmailType.PASSWORD,
        code: 'ABC123',
        expireAt: new Date(Date.now() + 60000),
        isCertified: false,
        userId: null,
      });

      await expect(sut.resetPasswordVerify({ id: 1, code: 'ABC123' })).rejects.toThrow(
        new BadRequestException('인증 데이터가 유효하지 않습니다.'),
      );
    });

    it('만료된 코드 → BadRequestException', async () => {
      emailSendHistoryRepository.findOne.mockResolvedValue({
        id: 1,
        type: EmailType.PASSWORD,
        code: 'ABC123',
        expireAt: new Date(Date.now() - 1000),
        isCertified: false,
        userId: 42,
      });

      await expect(sut.resetPasswordVerify({ id: 1, code: 'ABC123' })).rejects.toThrow(
        new BadRequestException('만료된 인증 코드입니다.'),
      );
    });

    it('코드 불일치 → BadRequestException', async () => {
      emailSendHistoryRepository.findOne.mockResolvedValue({
        id: 1,
        type: EmailType.PASSWORD,
        code: 'CORRECT',
        expireAt: new Date(Date.now() + 60000),
        isCertified: false,
        userId: 42,
      });

      await expect(sut.resetPasswordVerify({ id: 1, code: 'WRONG' })).rejects.toThrow(
        new BadRequestException('코드가 일치하지 않습니다.'),
      );
    });

    it('history.userId로 유저 조회, 비밀번호 변경', async () => {
      const givenUser = {
        id: 42,
        email: 'user@test.com',
        loginVerifyMethod: LoginVerifyMethod.EMAIL,
        password: 'old',
        isPasswordReset: false,
        passwordChangedAt: new Date(),
      };

      emailSendHistoryRepository.findOne.mockResolvedValue({
        id: 1,
        type: EmailType.PASSWORD,
        code: 'ABC123',
        expireAt: new Date(Date.now() + 60000),
        isCertified: false,
        userId: 42,
      });
      userRepository.findOne.mockResolvedValue(givenUser);
      emailSendHistoryRepository.save.mockResolvedValue({});
      userRepository.save.mockResolvedValue({});

      await sut.resetPasswordVerify({ id: 1, code: 'ABC123' });

      expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: 42 } });
      expect(userRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ isPasswordReset: true, passwordChangedAt: null }),
      );
    });
  });
});
