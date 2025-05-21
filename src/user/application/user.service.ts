import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  UserLoginByEmailPasswordReqDto,
  UserLoginEmailSendReqDto,
  UserLoginEmailVerifyReqDto,
  UserSignUpReqDto,
} from '../api/user.req.dto';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { ILoginTokenValidator } from '../../auth/interface/login.token.validator';
import { UserEntity } from '../../entity/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserLoginByEmailPasswordResDto } from '../api/user.res.dto';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { IMailSend } from '../../mail/interface/mail-send';
import { EmailType } from '../../mail/domain/email.type';
import { addMinutes, endOfDay, startOfDay } from 'date-fns';
import { generateRandomCode } from '../../user_find/domain/code.generate';
import { EmailCertifyExpireMinute } from '../../const';
import { userLoginTemplateHtml } from '../domain/user.login.template.html';
import { IUserAuthority } from '../interface/user.authority';
import { IUserStatus } from '../interface/user.status';
import { IUserSettleCondition } from '../interface/user.settle.condition';
import { IUserSettleMethod } from '../interface/user.settle.method';

@Injectable()
export class UserService {
  constructor(
    private passwordEncrypt: PasswordBcryptEncrypt,
    @Inject('ILoginTokenValidator')
    private loginTokenValidator: ILoginTokenValidator,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @Inject('IMailSend')
    private readonly mailSendService: IMailSend,
  ) {}

  async isExistEmail(email: string) {
    const dupEmailUser = await this.userRepository.findOne({
      where: {
        email: email,
      },
    });

    return !!dupEmailUser;
  }

  @Transactional()
  async signUp(signUpDto: UserSignUpReqDto) {
    const {
      email,
      password,
      personName,
      personPhoneNumber,
      personEmail,
      businessType,
      corporateNumber,
      businessNumber,
      businessName,
      businessAddress,
      businessPhoneNumber,
      ip,
    } = signUpDto;

    const dupEmail = await this.userRepository.count({
      where: {
        email: email,
      },
    });

    if (dupEmail) {
      throw new BadRequestException('duplicate user email');
    }

    const passwordEncrypt = await this.passwordEncrypt.encrypt(password);

    await this.userRepository.insert({
      email: signUpDto.email,
      password: passwordEncrypt,
      personName,
      personPhoneNumber,
      personEmail,
      businessType,
      corporateNumber,
      businessNumber,
      businessName,
      businessAddress,
      businessPhoneNumber,
      ip,
      isPasswordReset: false,
      authority: IUserAuthority.CORPORATE_ADMIN,
      status: IUserStatus.NOT_APPROVED,
      personCode: businessNumber,
      settleCondition: IUserSettleCondition.POST_PAYMENT,
      settleMethod: IUserSettleMethod.CARD,
      bankName: '',
      bankNumber: '',
      cardName: '',
      cardNumber: '',
      maximumLimit: 0,
      balance: 0,
    });
    return;
  }

  async loginByEmailPassword(
    loginDto: UserLoginByEmailPasswordReqDto,
    reqIp: string | undefined,
  ): Promise<UserLoginByEmailPasswordResDto> {
    const { email, password } = loginDto;
    const user = await this.userRepository.findOne({
      where: {
        email: email,
      },
    });

    if (!user) {
      throw new BadRequestException('USER_DOES_NOT_EXIST');
    }
    if (user.status === IUserStatus.NOT_APPROVED) {
      throw new BadRequestException('승인후 사용 가능합니다.');
    }
    const isPasswordMatch = await this.passwordEncrypt.compare(password, user.password);
    if (!isPasswordMatch) {
      throw new BadRequestException('USER_DO_NOT_MATCH_PASSWORD');
    }

    const splitReqAllowedIp = reqIp ? reqIp.split(':') : ['', '', ''];

    const reqAllowedIp = splitReqAllowedIp[3];

    console.log(reqIp);
    console.log(reqAllowedIp)
    console.log(user.ip)
    if (user.ip !== reqAllowedIp) {
      throw new BadRequestException('허용된 IP 가 아닙니다.');
    }

    const now = new Date();
    const startOfToday = startOfDay(now);
    const endOfToday = endOfDay(now);

    const emailCodeCount = await this.emailSendHistoryRepository.count({
      where: {
        email: user.email,
        type: EmailType.LOGIN,
        isCertified: true,
        createdAt: Between(startOfToday, endOfToday),
      },
    });

    const loginUserInfo: ILoginUserInfo = {
      id: user.id,
      email: user.email,
      authority: user.authority,
    };

    if (emailCodeCount === 0) {
      return {
        ...this.loginTokenValidator.issuance(loginUserInfo),
        authority: user.authority,
        personName: user.personName,
        isPasswordReset: user.isPasswordReset,
        isEmailVerify: false,
      };
    }

    return {
      ...this.loginTokenValidator.issuance(loginUserInfo),
      authority: user.authority,
      personName: user.personName,
      isPasswordReset: user.isPasswordReset,
      isEmailVerify: true,
    };
  }

  async loginEmailSend(getBody: UserLoginEmailSendReqDto) {
    const { email } = getBody;

    const user = await this.userRepository.findOne({
      where: {
        email: email,
      },
    });

    if (!user) {
      throw new BadRequestException('해당 이메일의 유저가 존재하지 않습니다.');
    }

    const code = generateRandomCode();
    const expireAt = addMinutes(new Date(), EmailCertifyExpireMinute);

    // 이메일 전송한 history record 생성하기
    const emailSendHistory = new EmailSendHistoryEntity();

    emailSendHistory.email = getBody.email;
    emailSendHistory.type = EmailType.LOGIN;
    emailSendHistory.expireAt = expireAt;
    emailSendHistory.code = code;

    const { title, content } = userLoginTemplateHtml(code, EmailCertifyExpireMinute);

    await this.mailSendService.send({
      saveSentMail: 'N',
      bcc: undefined,
      cc: undefined,
      content: content,
      subject: title,
      to: email,
    });

    await this.emailSendHistoryRepository.save(emailSendHistory);

    return { id: emailSendHistory.id };
  }

  async loginEmailVerify(getBody: UserLoginEmailVerifyReqDto) {
    const { id, code, email } = getBody;

    const emailSendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        id: id,
        type: EmailType.LOGIN,
      },
    });

    if (!emailSendHistory) {
      throw new BadRequestException('이메일 전송 데이터가 없습니다.');
    }

    if (emailSendHistory.expireAt < new Date()) {
      throw new BadRequestException('만료된 이메일 인증 코드입니다.');
    }

    if (emailSendHistory.code !== code) {
      throw new BadRequestException('코드가 일치하지 않습니다.');
    }

    if (emailSendHistory.isCertified) {
      throw new BadRequestException('이미 인증 완료된 코드입니다.');
    }

    const user = await this.userRepository.findOne({
      where: {
        email: email,
      },
    });

    if (!user) {
      throw new BadRequestException('해당 이메일의 유저가 존재하지 않습니다.');
    }

    emailSendHistory.isCertified = true;
    await this.emailSendHistoryRepository.save(emailSendHistory);
  }

  async getAccessByRefresh(token: string) {
    const userDecode = this.loginTokenValidator.validateByToken(token);

    const user = await this.userRepository.findOne({
      where: { id: userDecode.id },
    });

    if (!user) {
      throw new BadRequestException('USER_DOES_NOT_EXIST');
    }

    const loginUserInfo: ILoginUserInfo = {
      id: user.id,
      email: user.email,
      authority: user.authority,
    };

    const loginToken = this.loginTokenValidator.issuance(loginUserInfo);

    return {
      accessToken: loginToken.accessToken,
    };
  }

  async getLoginTokenByRefresh(token: string) {
    const userDecode = this.loginTokenValidator.validateByToken(token);

    const user = await this.userRepository.findOne({
      where: { id: userDecode.id },
    });

    if (!user) {
      throw new BadRequestException('USER_DOES_NOT_EXIST');
    }

    const loginUserInfo: ILoginUserInfo = {
      id: user.id,
      email: user.email,
      authority: user.authority,
    };

    return this.loginTokenValidator.issuance(loginUserInfo);
  }

  async delete(user: ILoginUserInfo) {
    const oneUser = await this.userRepository.findOne({
      where: {
        id: user.id,
      },
    });

    if (!oneUser) {
      throw new BadRequestException('USER_DOES_NOT_EXIST');
    }

    await this.userRepository.delete(user.id);
  }
}
