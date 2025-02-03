import { Injectable, Logger } from '@nestjs/common';
import { DeliveryAlimTalk, IDeliveryAlimTalkSend, IDeliveryAlimTalkSendOut } from '../interface/delivery.alim.talk';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, lastValueFrom } from 'rxjs';

type InfoBankAuthResponse = {
  schema: string;
  expired: string;
  token: string;
};

class DeliveryInfoBankAuth {
  static schema: string = '';
  static token: string = '';
  static expired: number = 0;
}

export type InfoBankSendResponse = { code: string; result: string; msgKey: string; ref?: string };

export type InfoBankReportResponse = {
  code: string;
  result: string;
  data: {
    report: {
      msgKey: string;
      serviceType: string;
      msgType: string;
      sendTime: string;
      reportTime: string;
      reportType: string;
      reportText: string;
      carrier: string;
      ref: string;
    }[];
  };
};

@Injectable()
export class DeliveryAlimTalkInfoBankHttp implements DeliveryAlimTalk {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.infoBankId = this.configService.getOrThrow('ALIM_TALK_INFO_BANK_ID');
    this.infoBankPassword = this.configService.getOrThrow('ALIM_TALK_INFO_BANK_PASSWORD');
    this.infoBankSenderKey = this.configService.getOrThrow('ALIM_TALK_INFO_BANK_SENDER_KEY');
    this.infoBankTemplateCode = this.configService.getOrThrow('ALIM_TALK_INFO_BANK_TEMPLATE_CODE');
    if (this.configService.getOrThrow('ENVIRONMENT') === 'prod') {
      this.infoBankUrl = 'https://omni.ibapi.kr';
    }
  }

  private logger = new Logger('INFO_BANK');

  private infoBankId: string = '';
  private infoBankPassword: string = '';
  private infoBankSenderKey: string = '';
  private infoBankTemplateCode: string = '';

  private infoBankUrl = 'https://omni.ibapi.kr';

  private async getToken(): Promise<string> {
    const now = new Date().getTime() / 1000;
    if (DeliveryInfoBankAuth.expired <= now) {
      const token = await this.getTokenByServer();

      DeliveryInfoBankAuth.expired = new Date(token.expired).getTime() / 1000;
      DeliveryInfoBankAuth.token = token.token;
      DeliveryInfoBankAuth.schema = token.schema;
    }

    return `${DeliveryInfoBankAuth.schema} ${DeliveryInfoBankAuth.token}`;
  }
  private async getTokenByServer(): Promise<InfoBankAuthResponse> {
    const url = `${this.infoBankUrl}/v1/auth/token`;

    const headers = {
      'X-IB-Client-Id': this.infoBankId,
      'X-IB-Client-Passwd': this.infoBankPassword,
      Accept: 'application/json',
    };

    try {
      const resultResponse = await lastValueFrom(this.httpService.post(url, {}, { headers }));
      const response = resultResponse.data.data;

      return {
        schema: response.schema,
        expired: response.expired,
        token: response.token,
      };
    } catch (e) {
      this.logger.error(e);
      throw new Error(e);
    }
  }

  async send(sendObj: IDeliveryAlimTalkSend): Promise<IDeliveryAlimTalkSendOut> {
    const url = `${this.infoBankUrl}/v1/send/alimtalk`;

    try {
      const token = await this.getToken();
      const headers = {
        Authorization: token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const body = {
        senderKey: this.infoBankSenderKey,
        msgType: 'AI',
        to: sendObj.to,
        templateCode: this.infoBankTemplateCode,
        text: sendObj.text,
        button: [
          // TODO Button 템플릿에 따라 수정 필요
          {
            type: 'MD',
            name: '선물 확인(테스트용)',
          },
        ],
      };

      const response = await firstValueFrom(this.httpService.post(url, body, { headers }));

      const responseData = response.data as InfoBankSendResponse;
      const reportResponse = await firstValueFrom(
        this.httpService.get(`${this.infoBankUrl}/v1/report/inquiry/${responseData.msgKey}`, { headers }),
      );
      const reportData = reportResponse.data as InfoBankReportResponse;
      return { responseData, report: reportData };
    } catch (e) {
      this.logger.error(e);

      throw new Error(e);
    }
  }
}
