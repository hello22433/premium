import { Injectable, Logger } from '@nestjs/common';
import { DeliveryAlimTalk, IDeliveryAlimTalkSend, IDeliveryAlimTalkSendOut } from '../interface/delivery.alim.talk';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, lastValueFrom } from 'rxjs';
import { listToMap } from '../../util/map.util';

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
      reportCode: string;
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
    this.receiveUrl = this.configService.getOrThrow('ALIM_TALK_RECEIVE_URL');
    if (this.configService.getOrThrow('ENVIRONMENT') === 'prod') {
      this.infoBankUrl = 'https://omni.ibapi.kr';
    }
  }

  private logger = new Logger('INFO_BANK');

  private infoBankId: string = '';
  private infoBankPassword: string = '';
  private infoBankSenderKey: string = '';
  private infoBankTemplateCode: string = '';
  private receiveUrl: string = '';

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
          {
            type: 'WL',
            name: '선물메시지 확인',
            // urlPc: `${this.receiveUrl}/${sendObj.encryptKey}`,
            urlMobile: `${this.receiveUrl}/${sendObj.encryptKey}`,
          },
        ],
      };

      const response = await firstValueFrom(this.httpService.post(url, body, { headers }));

      const responseData = response.data as InfoBankSendResponse;

      try {
        await firstValueFrom(
          this.httpService.delete(`${this.infoBankUrl}/v1/report/polling/${responseData.msgKey}`, { headers }),
        );
      } catch (e) {
        this.logger.log(`수신 확인 : ${JSON.stringify(e)}`);
      }
      // const reportResponse = await firstValueFrom(
      //   this.httpService.get(`${this.infoBankUrl}/v1/report/inquiry/${responseData.msgKey}`, { headers }),
      // );
      this.logger.log(`알림톡 발신 : ${JSON.stringify(responseData)}`);

      const msgKey = responseData.msgKey;

      // report 조회 재시도 (최대 3번, 각 1초 대기)
      let reportOne: { msgKey: string; reportCode: string; [key: string]: any } | undefined = undefined;
      let reportResponsePollingData: InfoBankReportResponse | null = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        await this.sleep(1000);

        const reportResponsePolling = await firstValueFrom(
          this.httpService.get(`${this.infoBankUrl}/v1/report/polling`, { headers }),
        );

        reportResponsePollingData = reportResponsePolling.data;
        const reportList = reportResponsePollingData?.data?.report || [];
        const reportMap = listToMap(reportList, (report: any) => report.msgKey);

        reportOne = reportMap.get(msgKey);
        if (reportOne) {
          this.logger.log(`Report found on attempt ${attempt}`);
          break;
        }

        this.logger.log(`Report not found on attempt ${attempt}, retrying...`);
      }

      if (!reportOne) {
        this.logger.error(JSON.stringify(reportResponsePollingData));
        this.logger.error(JSON.stringify(responseData));
        throw new Error(`msgKey "${msgKey}" not found in reportResponsePollingData after 3 attempts`);
      }

      if (reportOne.reportCode !== '10000') {
        this.logger.error(JSON.stringify(reportOne));
        throw new Error(`msgKey "${msgKey}" not send ${reportOne.reportCode}`);
      }

      const reportData = reportResponsePollingData as InfoBankReportResponse;

      return { responseData, report: reportData };
    } catch (e) {
      this.logger.error(e);

      throw new Error(e);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
