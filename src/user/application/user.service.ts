import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  UserLoginByEmailPasswordReqDto,
  UserLoginEmailSendReqDto,
  UserLoginEmailVerifyReqDto,
  UserLoginPhoneSendReqDto,
  UserLoginPhoneVerifyReqDto,
  UserSignUpReqDto,
} from '../api/user.req.dto';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { ILoginTokenValidator } from '../../auth/interface/login.token.validator';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { UserViewScopeEntity, ViewScopeType } from '../../entity/user.view.scope.entity';
import { PasswordPolicyEntity } from '../../entity/password.policy.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, Repository, Raw } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserLoginByEmailPasswordResDto } from '../api/user.res.dto';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { IMailSend } from '../../mail/interface/mail-send';
import { EmailType } from '../../mail/domain/email.type';
import { addMinutes, differenceInDays } from 'date-fns';
import { generateRandomCode, generateNumericCode } from '../../user_find/domain/code.generate';
import { EmailCertifyExpireMinute } from '../../const';
import { userLoginTemplateHtml } from '../domain/user.login.template.html';
import { IUserAuthority } from '../interface/user.authority';
import { IUserStatus } from '../interface/user.status';
import { IUserSettleCondition } from '../interface/user.settle.condition';
import { IUserSettleMethod } from '../interface/user.settle.method';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { LoginVerifyMethod } from '../interface/login.verify.method';
import { DeliveryAlimTalk } from '../../delivery/interface/delivery.alim.talk';
import { ISmsSend } from '../../sms/interface/sms.send';
import { defaultFromPhoneNumber } from '../../const';
import { MaskingUtil } from '../../common/utils/masking.util';

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
    @InjectRepository(UserViewScopeEntity)
    private userViewScopeRepository: Repository<UserViewScopeEntity>,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @InjectRepository(PasswordPolicyEntity)
    private passwordPolicyRepository: Repository<PasswordPolicyEntity>,
    @Inject('IMailSend')
    private readonly mailSendService: IMailSend,
    @Inject('DeliveryAlimTalk')
    private readonly alimTalkService: DeliveryAlimTalk,
    @Inject('ISmsSend')
    private readonly smsSendService: ISmsSend,
    private configService: ConfigService,
    private activityLogService: ActivityLogService,
  ) {}

  private logger = new Logger('UserService');

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

    const insertResult = await this.userRepository.insert({
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
      balance: 0,
      companyId: companyId,
    });

    // 신규 사용자의 조회 범위 기본값 설정 (SELF)
    const newUserId = insertResult.identifiers[0].id;
    await this.userViewScopeRepository.insert({
      userId: newUserId,
      scopeType: ViewScopeType.SELF,
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
    let passwordResetReason: 'TEMP' | 'EXPIRED' | null = user.isPasswordReset ? 'TEMP' : null;

    if (!shouldResetPassword && passwordPolicy) {
      const now = new Date();
      // passwordChangedAt이 null이거나 설정된 기간이 지났으면 비밀번호 변경 필요
      if (!user.passwordChangedAt) {
        shouldResetPassword = true;
        passwordResetReason = 'EXPIRED';
      } else {
        const daysSincePasswordChange = differenceInDays(now, user.passwordChangedAt);
        if (daysSincePasswordChange >= passwordPolicy.passwordExpiryDays) {
          shouldResetPassword = true;
          passwordResetReason = 'EXPIRED';
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

      const allowedIpList: string[] = user.ip ? user.ip.split(',').map((ip) => ip.trim()) : [];

      // @ts-ignore
      const splitAllowed = user.ip.split(',').map((ip) => ip.trim());
      console.log({ reqAllowedIp, splitAllowed });

      if (!allowedIpList.includes(reqAllowedIp)) {
        throw new BadRequestException('허용된 IP가 아닙니다.');
      }
    }

    // 담당자 이메일 파싱 (쉼표 구분)
    const personEmails = user.personEmail
      ? user.personEmail.split(',').map((e) => e.trim()).filter((e) => e)
      : [];

    // KST 기준으로 오늘 날짜 비교
    // MySQL 세션 타임존이 +09:00(KST)로 설정되어 있으므로
    // CURDATE()와 DATE() 함수는 KST 기준으로 동작
    // userId 기반으로 오늘 인증 이력 체크 (계정별 로그인 여부 확인)
    const emailCodeCount = await this.emailSendHistoryRepository.count({
      where: {
        userId: user.id,
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

    // 인증 방식에 따른 공통 응답 필드
    const loginVerifyMethod = user.loginVerifyMethod ?? LoginVerifyMethod.EMAIL;
    const maskedPhone = MaskingUtil.maskPhoneNumber(user.personPhoneNumber);

    const isEmailVerify = emailCodeCount > 0;

    return {
      ...this.loginTokenValidator.issuance(loginUserInfo),
      userId: user.id,
      authority: user.authority,
      personName: user.personName,
      email: user.email,
      isPasswordReset: shouldResetPassword,
      passwordResetReason,
      isEmailVerify,
      passwordChangedAt: user.passwordChangedAt,
      passwordExpiryDays: passwordPolicy?.passwordExpiryDays ?? null,
      personEmails,
      needEmailSelection: !isEmailVerify && loginVerifyMethod === LoginVerifyMethod.EMAIL && personEmails.length > 1,
      loginVerifyMethod,
      maskedPhoneNumber: maskedPhone,
    };
  }

  async loginEmailSend(getBody: UserLoginEmailSendReqDto) {
    const { email, targetEmail } = getBody;

    const user = await this.userRepository.findOne({
      where: {
        email: email,
      },
    });

    if (!user) {
      throw new BadRequestException('해당 이메일의 유저가 존재하지 않습니다.');
    }

    // 담당자 이메일 파싱
    const personEmails = user.personEmail
      ? user.personEmail.split(',').map((e) => e.trim()).filter((e) => e)
      : [];

    // 발송할 이메일 결정
    // - 담당자 이메일이 1개일 때: 계정 이메일로 발송
    // - 담당자 이메일이 2개 이상일 때: 선택한 담당자 이메일로 발송
    let sendToEmail: string;

    if (personEmails.length <= 1) {
      // 1개 이하일 때는 계정 이메일로 발송
      sendToEmail = email;
    } else {
      // 2개 이상일 때는 targetEmail 필수
      if (!targetEmail) {
        throw new BadRequestException('담당자 이메일이 2개 이상일 때는 targetEmail이 필수입니다.');
      }
      if (!personEmails.includes(targetEmail)) {
        throw new BadRequestException('유효하지 않은 담당자 이메일입니다.');
      }
      sendToEmail = targetEmail;
    }

    const code = generateRandomCode();
    const expireAt = addMinutes(new Date(), EmailCertifyExpireMinute);

    // 이메일 전송한 history record 생성하기
    const emailSendHistory = new EmailSendHistoryEntity();

    emailSendHistory.userId = user.id; // 계정별 인증 이력 관리
    emailSendHistory.email = sendToEmail;
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
      to: sendToEmail,
    });

    await this.emailSendHistoryRepository.save(emailSendHistory);

    return { id: emailSendHistory.id };
  }

  async loginPhoneSend(getBody: UserLoginPhoneSendReqDto) {
    const { email } = getBody;

    const user = await this.userRepository.findOne({
      where: { email },
    });

    if (!user) {
      throw new BadRequestException('해당 이메일의 유저가 존재하지 않습니다.');
    }

    if (!user.personPhoneNumber) {
      throw new BadRequestException('등록된 연락처가 없습니다. 관리자에게 문의해주세요.');
    }

    const code = generateNumericCode(5);
    const expireAt = addMinutes(new Date(), EmailCertifyExpireMinute);

    const messageText = `이팝콘 프리미엄 로그인 인증코드\n[${code}]`;

    // 알림톡 발송 시도 → 실패 시 SMS 대체 발송
    try {
      await this.alimTalkService.send({
        to: user.personPhoneNumber,
        text: messageText,
        templateCode: this.configService.getOrThrow('ALIM_TALK_INFO_BANK_LOGIN_AUTH_TEMPLATE_CODE'),
        msgType: 'AT',
      });
      this.logger.log(`로그인 인증코드 알림톡 발송 성공: userId=${user.id}`);
    } catch (alimTalkError) {
      this.logger.warn(`로그인 인증코드 알림톡 발송 실패, SMS 대체 발송: userId=${user.id}, error=${alimTalkError.message}`);

      try {
        await this.smsSendService.send({
          msgType: 'S',
          to: user.personPhoneNumber,
          from: user.fromPhoneNumber || defaultFromPhoneNumber,
          subject: '',
          text: messageText,
          filePath: [],
        });
        this.logger.log(`로그인 인증코드 SMS 발송 성공: userId=${user.id}`);
      } catch (smsError) {
        this.logger.error(`로그인 인증코드 SMS 발송 실패: userId=${user.id}, error=${smsError.message}`);
        throw new BadRequestException('인증코드 발송에 실패했습니다. 잠시 후 다시 시도해주세요.');
      }
    }

    // 발송 성공 후 인증 이력 저장
    const sendHistory = new EmailSendHistoryEntity();
    sendHistory.userId = user.id;
    sendHistory.email = user.personPhoneNumber; // 전화번호를 식별값으로 저장
    sendHistory.type = EmailType.LOGIN;
    sendHistory.expireAt = expireAt;
    sendHistory.code = code;

    await this.emailSendHistoryRepository.save(sendHistory);

    return { id: sendHistory.id };
  }

  async loginPhoneVerify(getBody: UserLoginPhoneVerifyReqDto) {
    await this.verifyLoginCode(getBody.id, getBody.code, getBody.email);
  }

  async loginEmailVerify(getBody: UserLoginEmailVerifyReqDto) {
    await this.verifyLoginCode(getBody.id, getBody.code, getBody.email);
  }

  private async verifyLoginCode(id: number, code: string, email: string) {
    const sendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        id: id,
        type: EmailType.LOGIN,
      },
    });

    if (!sendHistory) {
      throw new BadRequestException('인증 데이터가 없습니다.');
    }

    if (sendHistory.expireAt && sendHistory.expireAt < new Date()) {
      throw new BadRequestException('만료된 인증 코드입니다.');
    }

    if (sendHistory.code !== code) {
      throw new BadRequestException('코드가 일치하지 않습니다.');
    }

    if (sendHistory.isCertified) {
      throw new BadRequestException('이미 인증 완료된 코드입니다.');
    }

    // userId로 소유권 검증
    const user = await this.userRepository.findOne({
      where: { email },
    });

    if (!user || user.id !== sendHistory.userId) {
      throw new BadRequestException('유효하지 않은 인증 요청입니다.');
    }

    sendHistory.isCertified = true;
    await this.emailSendHistoryRepository.save(sendHistory);
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
