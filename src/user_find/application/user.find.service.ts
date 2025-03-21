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
import { BadRequestException, Inject } from '@nestjs/common';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { EmailCertifyExpireMinute } from '../../const';
import { addMinutes } from 'date-fns';
import { EmailType } from '../../mail/domain/email.type';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { UserResetPasswordVerifyTemplateHtml } from '../domain/user.reset.password.verify.template.html';
import { generateRandomCode } from '../domain/code.generate';
import { generateRandomPassword } from '../domain/user.password.regex';
import { userResetPasswordTemplate } from '../domain/user.reset.password.template.html';

export class UserFindService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @Inject('IMailSend')
    private readonly mailSendService: IMailSend,
    private readonly passwordEncrypt: PasswordBcryptEncrypt,
  ) {}

  async findId(getBody: UserFindIdReqDto): Promise<UserFindIdResDto> {
    const user = await this.userRepository.findOne({
      where: {
        businessNumber: getBody.businessNumber,
        personName: getBody.personName,
        personPhoneNumber: getBody.personPhoneNumber,
      },
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
        businessNumber: businessNumber,
        personName,
        personPhoneNumber,
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
    emailSendHistory.type = EmailType.PASSWORD;
    emailSendHistory.expireAt = expireAt;
    emailSendHistory.code = code;

    const { title, content } = UserResetPasswordVerifyTemplateHtml(code, EmailCertifyExpireMinute);

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

  async resetPasswordVerify(getBody: UserFindResetPasswordVerifyReqDto) {
    const { id, code, email } = getBody;

    const emailSendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        id: id,
        type: EmailType.PASSWORD,
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

    const tempPassword = generateRandomPassword();

    const { title, content } = userResetPasswordTemplate(tempPassword);

    await this.mailSendService.send({
      saveSentMail: 'N',
      bcc: undefined,
      cc: undefined,
      content: content,
      subject: title,
      to: email,
    });

    user.password = await this.passwordEncrypt.encrypt(tempPassword);
    user.isPasswordReset = true;

    await this.userRepository.save(user);
    emailSendHistory.isCertified = true;
    await this.emailSendHistoryRepository.save(emailSendHistory);

    return;
  }
}
