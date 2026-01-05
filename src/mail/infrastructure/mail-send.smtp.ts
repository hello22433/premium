import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

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
}

export interface ISmtpMailSendOut {
  success: boolean;
  messageId?: string;
  error?: string;
}

@Injectable()
export class MailSendSmtp {
  private transporter: Transporter;
  private logger = new Logger('MAIL_SMTP');

  // 발신자 정보 (하드코딩)
  private readonly FROM_EMAIL = 'service@enmad.com';
  private readonly FROM_NAME = '(주)모바일이앤엠애드_운영팀';

  constructor(private configService: ConfigService) {
    const host = this.configService.get('SMTP_HOST');
    const port = this.configService.get('SMTP_PORT');
    const user = this.configService.get('SMTP_ID');
    const pass = this.configService.get('SMTP_PWD');

    this.transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: Number(port) === 465, // 465는 SSL, 587은 TLS
      auth: {
        user,
        pass,
      },
    });
  }

  async send(obj: ISmtpMailSendIn): Promise<ISmtpMailSendOut> {
    try {
      // 줄바꿈을 <br>로 변환 (HTML에서 줄바꿈 적용)
      const htmlContent = obj.content.replace(/\n/g, '<br>');

      const mailOptions: nodemailer.SendMailOptions = {
        from: {
          name: this.FROM_NAME,
          address: this.FROM_EMAIL,
        },
        to: obj.to,
        subject: obj.subject,
        html: htmlContent,
      };

      // 참조(CC) 처리
      if (obj.cc) {
        mailOptions.cc = obj.cc;
      }

      // 첨부파일 처리
      if (obj.attachments && obj.attachments.length > 0) {
        mailOptions.attachments = obj.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType || 'application/pdf',
        }));
      }

      const result = await this.transporter.sendMail(mailOptions);

      this.logger.log(`이메일 전송 성공: ${result.messageId}`);

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