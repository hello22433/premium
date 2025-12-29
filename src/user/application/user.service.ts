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
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { PasswordPolicyEntity } from '../../entity/password.policy.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, Repository, Raw } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserLoginByEmailPasswordResDto } from '../api/user.res.dto';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { IMailSend } from '../../mail/interface/mail-send';
import { EmailType } from '../../mail/domain/email.type';
import { addMinutes, differenceInDays } from 'date-fns';
import { generateRandomCode } from '../../user_find/domain/code.generate';
import { EmailCertifyExpireMinute } from '../../const';
import { userLoginTemplateHtml } from '../domain/user.login.template.html';
import { IUserAuthority } from '../interface/user.authority';
import { IUserStatus } from '../interface/user.status';
import { IUserSettleCondition } from '../interface/user.settle.condition';
import { IUserSettleMethod } from '../interface/user.settle.method';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';

@Injectable()
export class UserService {
  constructor(
    private passwordEncrypt: PasswordBcryptEncrypt,
    @Inject('ILoginTokenValidator')
    private loginTokenValidator: ILoginTokenValidator,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(UserCompanyEntity)
    private userCompanyRepository: Repository<UserCompanyEntity>,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @InjectRepository(PasswordPolicyEntity)
    private passwordPolicyRepository: Repository<PasswordPolicyEntity>,
    @Inject('IMailSend')
    private readonly mailSendService: IMailSend,
    private activityLogService: ActivityLogService,
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
      industryType,
      industryItem,
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

    // 동일 사업자등록번호의 회사가 있으면 연결, 없으면 생성
    let companyId: number | null = null;
    if (businessNumber) {
      const existingCompany = await this.userCompanyRepository.findOne({
        where: { businessNumber },
      });
      if (existingCompany) {
        companyId = existingCompany.id;
      } else {
        // 새 회사 생성
        const newCompany = await this.userCompanyRepository.save({
          businessNumber,
          businessName,
          businessAddress,
          businessPhoneNumber,
          industryType: industryType ?? null,
          industryItem: industryItem ?? null,
          maximumLimit: 0,
        });
        companyId = newCompany.id;
      }
    }

    await this.userRepository.insert({
      email: signUpDto.email,
      password: passwordEncrypt,
      personName,
      personPhoneNumber,
      personEmail,
      businessType,
      corporateNumber,
      ip,
      isPasswordReset: false,
      passwordChangedAt: new Date(),
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
      companyId: companyId,
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
      relations: ['company'],
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

    // password_policy에서 최신 정책 조회 (soft delete 제외)
    const passwordPolicy = await this.passwordPolicyRepository.findOne({
      where: { deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });

    // 비밀번호 변경 기간 체크
    let shouldResetPassword = user.isPasswordReset;

    if (!shouldResetPassword && passwordPolicy) {
      const now = new Date();
      // passwordChangedAt이 null이거나 설정된 기간이 지났으면 비밀번호 변경 필요
      if (!user.passwordChangedAt) {
        shouldResetPassword = true;
      } else {
        const daysSincePasswordChange = differenceInDays(now, user.passwordChangedAt);
        if (daysSincePasswordChange >= passwordPolicy.passwordExpiryDays) {
          shouldResetPassword = true;
        }
      }
    }

    if (reqIp != '::1') {
      // IPv6 mapped IPv4 (::ffff:x.x.x.x) 또는 일반 IPv4 (x.x.x.x) 처리
      let reqAllowedIp: string = reqIp || '';
      if (reqIp && reqIp.includes('::ffff:')) {
        reqAllowedIp = reqIp.split(':').pop() || reqIp;
      }

      console.log(reqIp);
      console.log(reqAllowedIp);
      console.log(user.ip);

      const allowedIpList: string[] = user.ip ? user.ip.split('::') : [];

      // @ts-ignore
      const splitAllowed = user.ip.split('::');
      console.log({ reqAllowedIp, splitAllowed });

      if (!allowedIpList.includes(reqAllowedIp)) {
        throw new BadRequestException('허용된 IP가 아닙니다.');
      }
    }

    // KST 기준으로 오늘 날짜 비교
    // MySQL 세션 타임존이 +09:00(KST)로 설정되어 있으므로
    // CURDATE()와 DATE() 함수는 KST 기준으로 동작
    const emailCodeCount = await this.emailSendHistoryRepository.count({
      where: {
        email: user.email,
        type: EmailType.LOGIN,
        isCertified: true,
        createdAt: Raw((alias) => `DATE(${alias}) = CURDATE()`),
      },
    });

    const loginUserInfo: ILoginUserInfo = {
      id: user.id,
      email: user.email,
      authority: user.authority,
    };

    // 로그인 성공 Activity Log 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/user/login-email-password',
      actionType: ActivityLogActionType.LOGIN,
      ipAddress: reqIp || '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: {
        authority: user.authority,
        businessName: user.company?.businessName ?? '',
      },
    });

    if (emailCodeCount === 0) {
      return {
        ...this.loginTokenValidator.issuance(loginUserInfo),
        authority: user.authority,
        personName: user.personName,
        isPasswordReset: shouldResetPassword,
        isEmailVerify: false,
        passwordChangedAt: user.passwordChangedAt,
        passwordExpiryDays: passwordPolicy?.passwordExpiryDays ?? null,
      };
    }

    return {
      ...this.loginTokenValidator.issuance(loginUserInfo),
      authority: user.authority,
      personName: user.personName,
      isPasswordReset: shouldResetPassword,
      isEmailVerify: true,
      passwordChangedAt: user.passwordChangedAt,
      passwordExpiryDays: passwordPolicy?.passwordExpiryDays ?? null,
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
