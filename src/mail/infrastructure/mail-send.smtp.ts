import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { CompanyType } from '../../common/domain/company.type';

export interface ISmtpMailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface ISmtpMailSendIn {
  to: string;
  cc?: string;
  subject: string;
  content: string;
  attachments?: ISmtpMailAttachment[];
  companyType?: CompanyType;
}

export interface ISmtpMailSendOut {
  success: boolean;
  messageId?: string;
  error?: string;
}

interface SmtpProfile {
  transporter: Transporter;
  fromEmail: string;
  fromName: string;
}

@Injectable()
export class MailSendSmtp {
  private readonly profiles: Record<CompanyType, SmtpProfile>;
  private readonly bccEmail: string | undefined;
  private logger = new Logger('MAIL_SMTP');

  constructor(private configService: ConfigService) {
    this.bccEmail = this.configService.get('SMTP_ID');
    const host = this.configService.get('SMTP_HOST');
    const port = Number(this.configService.get('SMTP_PORT'));
    const secure = port === 465;

    // ENMAD (기본)
    this.profiles = {
      [CompanyType.ENMAD]: {
        transporter: nodemailer.createTransport({
          host,
          port,
          secure,
          auth: {
            user: this.configService.get('SMTP_ID'),
            pass: this.configService.get('SMTP_PWD'),
          },
        }),
        fromEmail: 'service@enmad.com',
        fromName: '(주)모바일이앤엠애드_운영팀',
      },
      [CompanyType.SYSCUSS]: {
        transporter: nodemailer.createTransport({
          host,
          port,
          secure,
          auth: {
            user: this.configService.get('SYSCUSS_SMTP_ID'),
            pass: this.configService.get('SYSCUSS_PWD'),
          },
        }),
        fromEmail: 'service@syscuss.com',
        fromName: '(주)시스커스_운영팀',
      },
    };
  }

  async send(obj: ISmtpMailSendIn): Promise<ISmtpMailSendOut> {
    try {
      const companyType = obj.companyType || CompanyType.ENMAD;
      const profile = this.profiles[companyType];

      const mailOptions: nodemailer.SendMailOptions = {
        from: {
          name: profile.fromName,
          address: profile.fromEmail,
        },
        to: obj.to,
        cc: obj.cc || undefined,
        subject: obj.subject,
        html: obj.content.replace(/\n/g, '<br>'),
      };

      // 숨은참조(BCC) - SMTP 계정으로 고정
      if (this.bccEmail) {
        mailOptions.bcc = this.bccEmail;
      }

      // 첨부파일 처리
      if (obj.attachments?.length) {
        mailOptions.attachments = obj.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType || 'application/pdf',
        }));
      }

      const result = await profile.transporter.sendMail(mailOptions);

      this.logger.log(`이메일 전송 성공 [${companyType}]: ${result.messageId}`);

      return {
        success: true,
        messageId: result.messageId,
      };
    } catch (error) {
      this.logger.error('이메일 전송 실패:', error);
      return {
        success: false,
        error: error.message || '이메일 전송에 실패했습니다.',
      };
    }
  }
}
