import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
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
import { generateLoginVerifyCode, generateNumericCode } from '../../user_find/domain/code.generate';
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
import { AuthErrorCode } from '../exception/auth-error-code';
import { AuthException } from '../exception/auth.exception';
import { AccountStatusTransitionService } from '../../account_lifecycle/application/account.status.transition.service';
import { TransitionSource } from '../../account_lifecycle/interface/transition.source';

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
    private accountStatusTransitionService: AccountStatusTransitionService,
    private cryptoCipher: CryptoCipher,
  ) {}

  private logger = new Logger('UserService');

  private static readonly MAX_LOGIN_FAIL = 5;

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
      lastActivityAt: new Date(),
    });

    // 신규 사용자의 조회 범위 기본값 설정 (SELF)
    const newUserId = insertResult.identifiers[0].id;
    await this.userViewScopeRepository.insert({
      userId: newUserId,
      scopeType: ViewScopeType.SELF,
    });

    // 계정 생성 로그 (라이프사이클)
    await this.accountStatusTransitionService.logAccountCreate(newUserId, signUpDto.email, TransitionSource.MANUAL);

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
      throw new AuthException(AuthErrorCode.USER_NOT_FOUND);
    }
    this.assertLoginableAccount(user);
    const isPasswordMatch = await this.passwordEncrypt.compare(password, user.password);
    if (!isPasswordMatch) {
      const { remaining, locked, justLocked } = await this.registerLoginFailure(user.id);
      await this.logLoginFailure(user, reqIp, remaining, justLocked);
      if (locked) {
        throw new AuthException(AuthErrorCode.ACCOUNT_LOCKED);
      }
      throw new AuthException(AuthErrorCode.INVALID_PASSWORD, { remainingAttempts: remaining });
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
      const reqAllowedIp = reqIp?.includes('::ffff:') ? (reqIp.split(':').pop() ?? reqIp) : (reqIp ?? '');

      const allowedIpList: string[] = user.ip ? user.ip.split(',').map((ip) => ip.trim()) : [];

      if (!allowedIpList.includes(reqAllowedIp)) {
        const { remaining, locked, justLocked } = await this.registerLoginFailure(user.id);
        await this.logLoginFailure(user, reqIp, remaining, justLocked);
        if (locked) {
          throw new AuthException(AuthErrorCode.ACCOUNT_LOCKED);
        }
        throw new AuthException(AuthErrorCode.IP_NOT_ALLOWED, { remainingAttempts: remaining });
      }
    }

    const personEmails = this.parsePersonEmails(user.personEmail);

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

    // 로그인 성공 — 실패 카운트 리셋 (잠금은 가드에서 이미 통과 = false)
    if (user.loginFailCount > 0) {
      await this.userRepository.update(user.id, { loginFailCount: 0, lockedAt: null });
    }

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

    // 활동 시각 갱신 (휴면 판정 기준 = 로그인 OR API. throttle 1일)
    await this.accountStatusTransitionService.touchLastActivity(user.id, user.lastActivityAt);

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

  /**
   * 로그인 실패 카운트 +1, 5회 도달 시 영구 잠금. 단일 조건부 UPDATE로 원자 처리.
   * MySQL은 SET 절을 좌→우 평가하므로 is_login_locked를 먼저 평가해 원본 카운트(+1) 기준으로 판단(off-by-one 회피).
   * WHERE is_login_locked = 0 + UPDATE 행 잠금으로 동시 실패에도 4→5 전이는 정확히 1회만 발생.
   */
  private async registerLoginFailure(
    userId: number,
  ): Promise<{ remaining: number; locked: boolean; justLocked: boolean }> {
    const max = UserService.MAX_LOGIN_FAIL;

    const result = await this.userRepository.query(
      'UPDATE `user` ' +
        'SET is_login_locked = (login_fail_count + 1 >= ?), ' +
        'locked_at = IF(login_fail_count + 1 >= ?, NOW(), locked_at), ' +
        'login_fail_count = LEAST(login_fail_count + 1, ?) ' +
        'WHERE id = ? AND is_login_locked = 0',
      [max, max, max, userId],
    );

    const fresh = await this.userRepository.findOne({
      where: { id: userId },
      select: { id: true, loginFailCount: true, isLoginLocked: true },
    });

    const affected = result?.affectedRows ?? 0;
    const locked = !!fresh?.isLoginLocked;
    // affectedRows=1 인 요청만이 4→5 전이를 수행 → LOCK 로그 1회 보장
    const justLocked = affected === 1 && locked;

    return {
      remaining: Math.max(0, max - (fresh?.loginFailCount ?? max)),
      locked,
      justLocked,
    };
  }

  /**
   * 로그인 실패 activity_log 기록. 방금 잠긴 요청(justLocked)만 ACCOUNT_LOCK 로그를 1회 추가.
   * requestParams allowlist: password/otp 금지.
   */
  private async logLoginFailure(
    user: UserEntity,
    reqIp: string | undefined,
    remaining: number,
    justLocked: boolean,
  ): Promise<void> {
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/user/login-email-password',
      actionType: ActivityLogActionType.LOGIN_FAIL,
      ipAddress: reqIp || '',
      statusCode: 400,
      result: ActivityLogResult.FAILURE,
      responseTime: 0,
      requestParams: { remaining },
    });

    if (justLocked) {
      await this.activityLogService.createLog({
        userId: user.id,
        userEmail: user.email,
        method: 'POST',
        requestUrl: '/user/login-email-password',
        actionType: ActivityLogActionType.ACCOUNT_LOCK,
        ipAddress: reqIp || '',
        statusCode: 400,
        result: ActivityLogResult.FAILURE,
        responseTime: 0,
        requestParams: { reason: 'PASSWORD_FAIL_5' },
      });
    }
  }

  async loginEmailSend(getBody: UserLoginEmailSendReqDto) {
    const { email, targetEmail } = getBody;

    const user = await this.userRepository.findOne({
      where: { email },
    });

    if (!user) {
      throw new AuthException(AuthErrorCode.USER_NOT_FOUND);
    }

    const personEmails = this.parsePersonEmails(user.personEmail);
    const sendToEmail = this.resolveTargetEmail(email, personEmails, targetEmail);

    const code = generateLoginVerifyCode();
    const expireAt = addMinutes(new Date(), EmailCertifyExpireMinute);

    // 이메일 전송한 history record 생성하기
    const emailSendHistory = new EmailSendHistoryEntity();

    emailSendHistory.userId = user.id; // 계정별 인증 이력 관리
    emailSendHistory.email = this.cryptoCipher.encryptDeliveryTarget(sendToEmail);
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
      throw new AuthException(AuthErrorCode.USER_NOT_FOUND);
    }

    if (!user.personPhoneNumber) {
      throw new AuthException(AuthErrorCode.PHONE_NOT_REGISTERED);
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
      this.logger.warn(
        `로그인 인증코드 알림톡 발송 실패, SMS 대체 발송: userId=${user.id}, error=${alimTalkError.message}`,
      );

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
        throw new AuthException(AuthErrorCode.SEND_FAILED);
      }
    }

    // 발송 성공 후 인증 이력 저장
    const sendHistory = new EmailSendHistoryEntity();
    sendHistory.userId = user.id;
    sendHistory.email = this.cryptoCipher.encryptDeliveryTarget(user.personPhoneNumber); // 전화번호를 식별값으로 암호화 저장
    sendHistory.type = EmailType.LOGIN;
    sendHistory.expireAt = expireAt;
    sendHistory.code = code;

    await this.emailSendHistoryRepository.save(sendHistory);

    return { id: sendHistory.id };
  }

  async loginPhoneVerify(getBody: UserLoginPhoneVerifyReqDto): Promise<void> {
    await this.verifyLoginCode(getBody.id, getBody.code, getBody.email);
  }

  async loginEmailVerify(getBody: UserLoginEmailVerifyReqDto): Promise<void> {
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
      throw new AuthException(AuthErrorCode.VERIFY_DATA_NOT_FOUND);
    }

    if (sendHistory.expireAt && sendHistory.expireAt < new Date()) {
      throw new AuthException(AuthErrorCode.EXPIRED_VERIFY_CODE);
    }

    if (sendHistory.code !== code.trim()) {
      throw new AuthException(AuthErrorCode.INVALID_VERIFY_CODE);
    }

    if (sendHistory.isCertified) {
      throw new AuthException(AuthErrorCode.ALREADY_VERIFIED);
    }

    // userId로 소유권 검증
    const user = await this.userRepository.findOne({
      where: { email },
    });

    if (!user || user.id !== sendHistory.userId) {
      throw new AuthException(AuthErrorCode.INVALID_VERIFY_REQUEST);
    }

    sendHistory.isCertified = true;
    await this.emailSendHistoryRepository.save(sendHistory);
  }

  /**
   * 휴면(NOT_USED) 계정 재활성화 — 본인인증 이메일 코드 발송.
   * 로그인 인증과 격리하기 위해 EmailType.REACTIVATE 사용.
   */
  async reactivateEmailSend(getBody: UserLoginEmailSendReqDto) {
    const { email, targetEmail } = getBody;

    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new AuthException(AuthErrorCode.USER_NOT_FOUND);
    }
    if (user.status === IUserStatus.LEAVE) {
      throw new AuthException(AuthErrorCode.ACCOUNT_WITHDRAWN); // 영구 차단 — 재활성화 불가
    }
    if (user.status !== IUserStatus.NOT_USED) {
      throw new AuthException(AuthErrorCode.REACTIVATION_NOT_ALLOWED); // 휴면 상태만 재활성화 대상
    }

    const personEmails = this.parsePersonEmails(user.personEmail);
    const sendToEmail = this.resolveTargetEmail(email, personEmails, targetEmail);

    const code = generateLoginVerifyCode();
    const expireAt = addMinutes(new Date(), EmailCertifyExpireMinute);

    const emailSendHistory = new EmailSendHistoryEntity();
    emailSendHistory.userId = user.id;
    emailSendHistory.email = this.cryptoCipher.encryptDeliveryTarget(sendToEmail);
    emailSendHistory.type = EmailType.REACTIVATE;
    emailSendHistory.expireAt = expireAt;
    emailSendHistory.code = code;

    const { title, content } = userLoginTemplateHtml(code, EmailCertifyExpireMinute);
    await this.mailSendService.send({
      saveSentMail: 'N',
      bcc: undefined,
      cc: undefined,
      content,
      subject: title,
      to: sendToEmail,
    });

    await this.emailSendHistoryRepository.save(emailSendHistory);
    return { id: emailSendHistory.id };
  }

  /**
   * 휴면 계정 재활성화 — 코드 검증 성공 시 USED 복귀 (last_activity_at=now, suspended_at=null).
   */
  async reactivateEmailVerify(getBody: UserLoginEmailVerifyReqDto) {
    const { id, code, email } = getBody;

    const sendHistory = await this.emailSendHistoryRepository.findOne({
      where: { id, type: EmailType.REACTIVATE },
    });
    if (!sendHistory) {
      throw new AuthException(AuthErrorCode.VERIFY_DATA_NOT_FOUND);
    }
    if (sendHistory.expireAt && sendHistory.expireAt < new Date()) {
      throw new AuthException(AuthErrorCode.EXPIRED_VERIFY_CODE);
    }
    if (sendHistory.code !== code.trim()) {
      throw new AuthException(AuthErrorCode.INVALID_VERIFY_CODE);
    }
    if (sendHistory.isCertified) {
      throw new AuthException(AuthErrorCode.ALREADY_VERIFIED);
    }

    const user = await this.userRepository.findOne({ where: { email } });
    if (!user || user.id !== sendHistory.userId) {
      throw new AuthException(AuthErrorCode.INVALID_VERIFY_REQUEST);
    }
    if (user.status !== IUserStatus.NOT_USED) {
      throw new AuthException(AuthErrorCode.REACTIVATION_NOT_ALLOWED);
    }

    sendHistory.isCertified = true;
    await this.emailSendHistoryRepository.save(sendHistory);

    // USED 복귀 — 휴면 시계 초기화
    await this.accountStatusTransitionService.transitionToUsed(user.id);
  }

  // 로그인/토큰 재발급 공통 계정 상태 게이트 (잠금·미승인·휴면·탈퇴 차단)
  private assertLoginableAccount(user: UserEntity): void {
    if (user.isLoginLocked) {
      throw new AuthException(AuthErrorCode.ACCOUNT_LOCKED); // 영구 잠금 — 관리자 해제까지 차단
    }
    if (user.status === IUserStatus.NOT_APPROVED) {
      throw new AuthException(AuthErrorCode.USER_NOT_APPROVED);
    }
    if (user.status === IUserStatus.NOT_USED) {
      throw new AuthException(AuthErrorCode.ACCOUNT_SUSPENDED); // 휴면 — 이메일 본인인증으로 재활성화 가능
    }
    if (user.status === IUserStatus.LEAVE) {
      throw new AuthException(AuthErrorCode.ACCOUNT_WITHDRAWN); // 탈퇴 — 영구 차단 (재활성화 불가)
    }
  }

  async getLoginTokenByRefresh(token: string) {
    const userDecode = this.loginTokenValidator.validateByToken(token, 'refresh');

    const user = await this.userRepository.findOne({
      where: { id: userDecode.id },
    });

    if (!user) {
      throw new BadRequestException('USER_DOES_NOT_EXIST');
    }

    // 토큰 발급 후 정지·탈퇴·잠금된 계정이 재발급으로 세션을 연장하지 못하도록 차단
    this.assertLoginableAccount(user);

    const loginUserInfo: ILoginUserInfo = {
      id: user.id,
      email: user.email,
      authority: user.authority,
    };

    return this.loginTokenValidator.issuance(loginUserInfo);
  }

  /**
   * E2E 테스트 전용: 인증 과정 없이 세션(토큰)을 즉시 발급한다.
   * ENVIRONMENT=prod 에서는 호출 불가.
   */
  async e2eSession(email: string): Promise<UserLoginByEmailPasswordResDto> {
    const user = await this.findE2eUser(email);

    const loginUserInfo: ILoginUserInfo = {
      id: user.id,
      email: user.email,
      authority: user.authority,
    };

    const personEmails = this.parsePersonEmails(user.personEmail);
    const loginVerifyMethod = user.loginVerifyMethod ?? LoginVerifyMethod.EMAIL;
    const maskedPhone = MaskingUtil.maskPhoneNumber(user.personPhoneNumber);

    this.logger.warn(`[E2E] e2e-session issued for ${email} (userId=${user.id})`);

    return {
      ...this.loginTokenValidator.issuance(loginUserInfo),
      userId: user.id,
      authority: user.authority,
      personName: user.personName,
      email: user.email,
      isPasswordReset: false,
      passwordResetReason: null,
      isEmailVerify: true,
      passwordChangedAt: user.passwordChangedAt,
      passwordExpiryDays: null,
      personEmails,
      needEmailSelection: false,
      loginVerifyMethod,
      maskedPhoneNumber: maskedPhone,
    };
  }

  /**
   * E2E 테스트 전용: 해당 계정의 오늘 로그인 인증 완료 상태를 주입한다.
   * UI 로그인 smoke 테스트에서 인증코드 분기를 건너뛰기 위한 용도.
   */
  async e2eSeedLoginVerification(email: string): Promise<void> {
    const user = await this.findE2eUser(email);

    // 오늘 이미 인증 완료 이력이 있으면 중복 생성하지 않음
    const existingCount = await this.emailSendHistoryRepository.count({
      where: {
        userId: user.id,
        type: EmailType.LOGIN,
        isCertified: true,
        createdAt: Raw((alias) => `DATE(${alias}) = CURDATE()`),
      },
    });

    if (existingCount > 0) {
      this.logger.warn(`[E2E] seed-login-verification skipped (already seeded) for ${email}`);
      return;
    }

    await this.emailSendHistoryRepository.insert({
      userId: user.id,
      email: this.cryptoCipher.encryptDeliveryTarget(this.parsePersonEmails(user.personEmail)[0] || email),
      type: EmailType.LOGIN,
      code: '000000',
      isCertified: true,
      expireAt: addMinutes(new Date(), 5),
    });

    this.logger.warn(`[E2E] seed-login-verification created for ${email} (userId=${user.id})`);
  }

  /** 비상용 환경 + allowlist 검증 후 E2E 계정 조회 */
  private async findE2eUser(email: string): Promise<UserEntity> {
    const env = this.configService.getOrThrow('ENVIRONMENT');
    if (env === 'prod') {
      throw new BadRequestException('NOT_AVAILABLE');
    }

    const allowedRaw = this.configService.get<string>('E2E_ALLOWED_EMAILS', '');
    const allowedEmails = allowedRaw
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e);
    if (!allowedEmails.includes(email)) {
      throw new BadRequestException('E2E_ACCOUNT_NOT_ALLOWED');
    }

    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new AuthException(AuthErrorCode.USER_NOT_FOUND);
    }

    return user;
  }

  private parsePersonEmails(personEmail: string | null): string[] {
    return personEmail
      ? personEmail
          .split(',')
          .map((e) => e.trim())
          .filter((e) => e)
      : [];
  }

  /**
   * 발송 대상 이메일 결정.
   * 담당자 이메일 1개 이하: 계정 이메일(accountEmail) 사용.
   * 2개 이상: targetEmail 필수 + allowlist 검증.
   */
  private resolveTargetEmail(accountEmail: string, personEmails: string[], targetEmail?: string): string {
    if (personEmails.length <= 1) {
      return accountEmail;
    }
    if (!targetEmail) {
      throw new AuthException(AuthErrorCode.TARGET_EMAIL_REQUIRED);
    }
    if (!personEmails.includes(targetEmail)) {
      throw new AuthException(AuthErrorCode.INVALID_TARGET_EMAIL);
    }
    return targetEmail;
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

    // hard delete 대체: LEAVE 전환(withdrawn_at + ACCOUNT_WITHDRAW 로그).
    // PII 는 거래이력 보존을 위해 즉시 파기하지 않고 +6개월 뒤 휴면배치가 익명화 처리한다.
    await this.accountStatusTransitionService.transitionToLeave(user.id, TransitionSource.MANUAL);
  }
}
