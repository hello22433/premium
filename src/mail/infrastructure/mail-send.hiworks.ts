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
      Authorization: `${this.officeToken}`,
    };

    const data = {
      to: obj.to,
      userId: this.id,
      cc: obj.cc,
      bcc: obj.bcc,
      subject: obj.subject,
      content: obj.content,
      saveSendMail: obj.saveSendMail,
    };

    try {
      const response = await firstValueFrom(this.httpService.post(url, data, { headers }));

      this.logger.log(response.data);
      return response.data as IMailSendOut;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }
}
