import { Injectable, Logger } from '@nestjs/common';
import { IMailSend, IMailSendIn, IMailSendOut } from '../interface/mail-send';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Blob } from 'buffer';

@Injectable()
export class MailSendHiworks implements IMailSend {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.id = this.configService.getOrThrow('MAIL_HIGH_WORKS_ID');
    this.officeToken = this.configService.getOrThrow('MAIL_HIGH_WORKS_OFFICE_TOKEN');
    if (this.configService.get('ENVIRONMENT') === 'prod') {
      this.url = 'https://api.hiworks.com'; // production 설정 용
    }
  }

  private logger = new Logger('MAIL_HI_WORKS');

  private url: string = 'https://api.hiworks.com';
  private id: string = '';
  private officeToken: string = '';

  async send(obj: IMailSendIn): Promise<IMailSendOut> {
    const url = `${this.url}/office/v2/webmail/sendMail`;
    const headers = {
      'Content-Type': 'multipart/form-data',
      Authorization: `Bearer ${this.officeToken}`,
    };

    const id = obj.fromEmail ? obj.fromEmail : this.id;
    const formData = new FormData();
    formData.append('to', obj.to);
    formData.append('user_id', id);
    formData.append('subject', obj.subject);
    formData.append('content', obj.content);
    formData.append('save_sent_mail', obj.saveSentMail ? obj.saveSentMail : 'N'); // 기본값 N

    if (obj.cc) {
      formData.append('cc', obj.cc);
    }
    if (obj.bcc) {
      formData.append('bcc', obj.bcc);
    }

    // 첨부파일 처리
    if (obj.attachments && obj.attachments.length > 0) {
      for (const attachment of obj.attachments) {
        const blob = new Blob([attachment.content], {
          type: attachment.contentType || 'application/octet-stream',
        });
        formData.append('file', blob as unknown as globalThis.Blob, attachment.filename);
      }
    }

    try {
      const response = await firstValueFrom(this.httpService.post(url, formData, { headers }));

      this.logger.log(response.data);

      // HiWorks API 응답에서 에러 체크 (HTTP 200이지만 응답 내용이 에러인 경우)
      if (response.data?.code === 'ERR') {
        this.logger.error(`이메일 전송 실패: ${response.data.message}`);
        throw new Error(response.data.message || '이메일 전송에 실패했습니다.');
      }

      return response.data as IMailSendOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(e.response?.data);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }
}
