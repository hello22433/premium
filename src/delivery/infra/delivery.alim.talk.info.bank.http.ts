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
    this.reportUrl = this.configService.getOrThrow('ALIM_TALK_REPORT_URL');
    this.apiKey = this.configService.getOrThrow('ALIM_TALK_API_KEY');
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
  private reportUrl: string = '';
  private apiKey: string = '';

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
      const msgKey = responseData.msgKey;

      this.logger.log(`알림톡 발신 : ${JSON.stringify(responseData)}`);

      // inquiry API로 수신 확인 재시도 (최대 3번, 각 1초 대기)
      let reportResult: { success: boolean; reportCode?: string; data?: any; error?: string } | undefined = undefined;

      for (let attempt = 1; attempt <= 3; attempt++) {
        await this.sleep(1000);

        reportResult = await this.inquiryReport(msgKey);

        if (reportResult.success && reportResult.data) {
          this.logger.log(`Report inquiry success on attempt ${attempt}: ${JSON.stringify(reportResult.data)}`);
          break;
        }

        this.logger.log(`Report inquiry failed on attempt ${attempt}: ${reportResult.error}, retrying...`);
      }

      if (!reportResult || !reportResult.success) {
        this.logger.error(`Final inquiry result: ${JSON.stringify(reportResult)}`);
        this.logger.error(`Original send response: ${JSON.stringify(responseData)}`);
        throw new Error(
          `msgKey "${msgKey}" inquiry failed after 3 attempts: ${reportResult?.error || 'Unknown error'}`,
        );
      }

      if (reportResult.reportCode !== '10000') {
        this.logger.error(JSON.stringify(reportResult.data));
        throw new Error(`msgKey "${msgKey}" not send successfully. reportCode: ${reportResult.reportCode}`);
      }

      // InfoBankReportResponse 형식으로 변환
      const reportData: InfoBankReportResponse = {
        code: 'A000',
        result: 'Success',
        data: {
          report: [reportResult.data],
        },
      };

      return { responseData, report: reportData };
    } catch (e) {
      this.logger.error(e);

      throw new Error(e);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async inquiryReport(msgKey: string): Promise<{
    success: boolean;
    reportCode?: string;
    data?: any;
    error?: string;
  }> {
    try {
      const url = `${this.reportUrl}/api/comm/v1/report/inquiry/${msgKey}`;
      const headers = {
        Authorization: this.apiKey,
        Accept: 'application/json',
      };

      const response = await firstValueFrom(this.httpService.get(url, { headers }));

      // 성공 응답 (200)
      if (response.status === 200 && response.data?.common?.authResult === 'SUCCESS') {
        const reportData = response.data?.data?.data?.report?.[0];
        if (reportData) {
          return {
            success: true,
            reportCode: reportData.reportCode,
            data: reportData,
          };
        }
      }

      return { success: false, error: 'No report data found' };
    } catch (e) {
      // 에러 응답 처리 (400, 401, 429, 500)
      if (e.response?.data) {
        const errorData = e.response.data;
        this.logger.warn(`Report inquiry error: ${JSON.stringify(errorData)}`);
        return {
          success: false,
          error: `${errorData.code}: ${errorData.result}`,
        };
      }

      this.logger.error(`Report inquiry failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }
}
