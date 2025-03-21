import { Injectable, Logger } from '@nestjs/common';
import { IMailSend, IMailSendIn, IMailSendOut } from '../interface/mail-send';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

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

    try {
      const response = await firstValueFrom(this.httpService.post(url, formData, { headers }));

      this.logger.log(response.data);
      return response.data as IMailSendOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(e.response.data);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }
}
