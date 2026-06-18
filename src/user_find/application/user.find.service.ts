import { UserEntity } from '../../entity/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  UserFindIdReqDto,
  UserFindResetPasswordSendReqDto,
  UserFindResetPasswordVerifyReqDto,
} from '../api/user.find.req.dto';
import { UserFindIdResDto, UserFindResetPasswordSendResDto } from '../api/user.find.res.dto';
import { IMailSend } from '../../mail/interface/mail-send';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { EmailCertifyExpireMinute, defaultFromPhoneNumber } from '../../const';
import { addMinutes } from 'date-fns';
import { EmailType } from '../../mail/domain/email.type';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { UserResetPasswordVerifyTemplateHtml } from '../domain/user.reset.password.verify.template.html';
import { generateRandomCode } from '../domain/code.generate';
import { generateRandomPassword } from '../domain/user.password.regex';
import { userResetPasswordTemplate } from '../domain/user.reset.password.template.html';
import { LoginVerifyMethod } from '../../user/interface/login.verify.method';
import { DeliveryAlimTalk } from '../../delivery/interface/delivery.alim.talk';
import { ISmsSend } from '../../sms/interface/sms.send';

@Injectable()
export class UserFindService {
  private readonly logger = new Logger('UserFindService');

  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @Inject('IMailSend')
    private readonly mailSendService: IMailSend,
    private readonly passwordEncrypt: PasswordBcryptEncrypt,
    @Inject('DeliveryAlimTalk')
    private readonly alimTalkService: DeliveryAlimTalk,
    @Inject('ISmsSend')
    private readonly smsSendService: ISmsSend,
    private readonly configService: ConfigService,
    private readonly cryptoCipher: CryptoCipher,
  ) {}

  private readonly loginAuthTemplateCode = this.configService.getOrThrow<string>('ALIM_TALK_INFO_BANK_LOGIN_AUTH_TEMPLATE_CODE');
  private readonly initPasswordTemplateCode = this.configService.getOrThrow<string>('ALIM_TALK_INFO_BANK_INIT_PASSWORD_TEMPLATE_CODE');

  private async sendViaAlimTalkWithSmsFallback(
    to: string,
    text: string,
    templateCode: string,
    fromPhone: string | null,
    logContext: string,
  ): Promise<void> {
    try {
      await this.alimTalkService.send({ to, text, templateCode, msgType: 'AT' });
      this.logger.log(`${logContext} 알림톡 발송 성공`);
    } catch (alimTalkError) {
      this.logger.warn(`${logContext} 알림톡 발송 실패, SMS 대체 발송: ${alimTalkError.message}`);
      try {
        await this.smsSendService.send({
          msgType: 'S',
          to,
          from: fromPhone || defaultFromPhoneNumber,
          subject: '',
          text,
          filePath: [],
        });
        this.logger.log(`${logContext} SMS 발송 성공`);
      } catch (smsError) {
        this.logger.error(`${logContext} SMS 발송 실패: ${smsError.message}`);
        throw new BadRequestException('발송에 실패했습니다. 잠시 후 다시 시도해주세요.');
      }
    }
  }

  async findId(getBody: UserFindIdReqDto): Promise<UserFindIdResDto> {
    const user = await this.userRepository.findOne({
      where: {
        company: { businessNumber: getBody.businessNumber },
        personName: getBody.personName,
        personPhoneNumber: getBody.personPhoneNumber,
      },
      relations: ['company'],
    });

    if (!user) {
      throw new BadRequestException('유저가 존재하지 않습니다.');
    }

    return { email: user.email };
  }

  async resetPasswordSend(getBody: UserFindResetPasswordSendReqDto): Promise<UserFindResetPasswordSendResDto> {
    const { email, businessNumber, personName, personPhoneNumber } = getBody;

    const user = await this.userRepository.findOne({
      where: {
        email: email,
        company: { businessNumber: businessNumber },
        personName,
        personPhoneNumber,
      },
      relations: ['company'],
    });

    if (!user) {
      throw new BadRequestException('해당 이메일의 유저가 존재하지 않습니다.');
    }

    const code = generateRandomCode();
    const expireAt = addMinutes(new Date(), EmailCertifyExpireMinute);

    const loginVerifyMethod = user.loginVerifyMethod ?? LoginVerifyMethod.EMAIL;

    // history record 생성
    const emailSendHistory = new EmailSendHistoryEntity();
    emailSendHistory.type = EmailType.PASSWORD;
    emailSendHistory.expireAt = expireAt;
    emailSendHistory.code = code;

    if (loginVerifyMethod === LoginVerifyMethod.PHONE) {
      if (!user.personPhoneNumber) {
        throw new BadRequestException('등록된 연락처가 없습니다. 관리자에게 문의해주세요.');
      }

      emailSendHistory.email = this.cryptoCipher.encryptDeliveryTarget(user.personPhoneNumber);

      const messageText = `이팝콘 프리미엄 비밀번호 찾기 인증코드\n[${code}]`;

      await this.sendViaAlimTalkWithSmsFallback(
        user.personPhoneNumber,
        messageText,
        this.loginAuthTemplateCode,
        user.fromPhoneNumber,
        `비밀번호찾기 인증코드 userId=${user.id}`,
      );
    } else {
      emailSendHistory.email = this.cryptoCipher.encryptDeliveryTarget(getBody.email);

      const { title, content } = UserResetPasswordVerifyTemplateHtml(code, EmailCertifyExpireMinute);

      await this.mailSendService.send({
        saveSentMail: 'N',
        bcc: undefined,
        cc: undefined,
        content: content,
        subject: title,
        to: email,
      });
    }

    emailSendHistory.userId = user.id;
    await this.emailSendHistoryRepository.save(emailSendHistory);

    return { id: emailSendHistory.id };
  }

  async resetPasswordVerify(getBody: UserFindResetPasswordVerifyReqDto) {
    const { id, code } = getBody;

    const emailSendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        id: id,
        type: EmailType.PASSWORD,
      },
    });

    if (!emailSendHistory) {
      throw new BadRequestException('인증 데이터가 없습니다.');
    }

    if (emailSendHistory.expireAt && emailSendHistory.expireAt < new Date()) {
      throw new BadRequestException('만료된 인증 코드입니다.');
    }

    if (emailSendHistory.code !== code) {
      throw new BadRequestException('코드가 일치하지 않습니다.');
    }

    if (emailSendHistory.isCertified) {
      throw new BadRequestException('이미 인증 완료된 코드입니다.');
    }

    if (!emailSendHistory.userId) {
      throw new BadRequestException('인증 데이터가 유효하지 않습니다.');
    }

    const user = await this.userRepository.findOne({
      where: {
        id: emailSendHistory.userId,
      },
    });

    if (!user) {
      throw new BadRequestException('해당 이메일의 유저가 존재하지 않습니다.');
    }

    const tempPassword = generateRandomPassword();
    const loginVerifyMethod = user.loginVerifyMethod ?? LoginVerifyMethod.EMAIL;

    if (loginVerifyMethod === LoginVerifyMethod.PHONE) {
      if (!user.personPhoneNumber) {
        throw new BadRequestException('등록된 연락처가 없습니다. 관리자에게 문의해주세요.');
      }

      const messageText = `임시 비밀번호는 [${tempPassword}] 입니다.`;

      await this.sendViaAlimTalkWithSmsFallback(
        user.personPhoneNumber,
        messageText,
        this.initPasswordTemplateCode,
        user.fromPhoneNumber,
        `임시비밀번호 userId=${user.id}`,
      );
    } else {
      const { title, content } = userResetPasswordTemplate(tempPassword);

      await this.mailSendService.send({
        saveSentMail: 'N',
        bcc: undefined,
        cc: undefined,
        content: content,
        subject: title,
        to: user.email,
      });
    }

    user.password = await this.passwordEncrypt.encrypt(tempPassword);
    user.isPasswordReset = true;
    user.passwordChangedAt = null; // 임시 비밀번호이므로 null로 설정

    await this.userRepository.save(user);
    emailSendHistory.isCertified = true;
    await this.emailSendHistoryRepository.save(emailSendHistory);

    return;
  }
}
