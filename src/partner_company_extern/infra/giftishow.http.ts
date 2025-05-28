import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { firstValueFrom } from 'rxjs';
import { Parser } from 'xml2js';
import {
  GifitiShowCancelIn,
  GifitiShowCheckIn,
  GiftiShowCheckOut,
  GiftiShowIssueIn,
  GiftiShowIssueOut,
  IGiftiShow,
} from '../interface/giftishow';

@Injectable()
export class GiftishowHttp implements IGiftiShow {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
    private cryptoCipher: CryptoCipher,
  ) {
    this.corpCode = this.configService.getOrThrow('GIFTI_SHOW_CORP_CODE');
    this.authToken = this.configService.getOrThrow('GIFTI_SHOW_CUSTOM_AUTH_TOKEN');
    if (this.configService.getOrThrow('ENVIRONMENT') === 'prod') {
      this.url = 'https://giftishowgw.giftishow.co.kr';
    }
  }

  private logger = new Logger('GIFTI_SHOW');

  private url: string = 'http://tgiftishowgw.giftishow.co.kr';
  private corpCode: string = '';
  private authToken: string = '';

  private parser() {
    return new Parser();
  }

  async issue(obj: GiftiShowIssueIn): Promise<GiftiShowIssueOut> {
    // const url = `${this.url}/media/request.asp`;
    const headers = {
      api_code: '0101',
      custom_auth_code: this.corpCode,
      custom_auth_token: this.authToken,
      custom_enc_flag: 'N',
      'Content-Type': 'application/xml', // XML로 요청을 보내기 위한 Content-Type
      Accept: 'application/xml', // XML 응답을 수신하기 위함
    };
    const queryParams = new URLSearchParams({
      MDCODE: this.corpCode,
      MSG: 'MSSAGE',
      TITLE: 'TITLE',
      CALLBACK: '0269413614',
      goods_id: obj.partnerCompanyCode,
      tr_id: obj.transactionId,
      sms_flag: 'N',
      gubun: 'Y',
      phone_no: '01000000000',
    });

    const url = `${this.url}/media/request.asp?${queryParams.toString()}`;

    try {
      this.logger.log(url);
      this.logger.log(headers);
      const response = await firstValueFrom(this.httpService.get(url, { headers }));

      const result = response.data;

      const resultToJson = (await this.parser().parseStringPromise(result)) as unknown as GiftiShowIssueOut;

      this.logger.log(result);
      this.logger.log(resultToJson);
      // this.logger.log(response.toString());
      return resultToJson as GiftiShowIssueOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  async check(obj: GifitiShowCheckIn): Promise<GiftiShowCheckOut> {
    const headers = {
      api_code: '0101',
      custom_auth_code: this.corpCode,
      custom_auth_token: this.authToken,
      custom_enc_flag: 'N',
      'Content-Type': 'application/xml', // XML로 요청을 보내기 위한 Content-Type
      Accept: 'application/xml', // XML 응답을 수신하기 위함
    };
    const queryParams = new URLSearchParams({
      MDCODE: this.corpCode,
      tr_id: obj.transactionId,
    });

    const url = `${this.url}/media/coupon_status.asp?${queryParams.toString()}`;
    this.logger.log('[GiftiShow] coupon_status → ', url);

    try {
      const { data } = await firstValueFrom(this.httpService.get(url, { headers }));

      // xml → json
      const parsed = await this.parser().parseStringPromise(data);
      const res = parsed?.response?.result ?? {};

      const pick = (x?: string[] | string) => (Array.isArray(x) ? (x[0] ?? '') : (x ?? ''));

      const out: GiftiShowCheckOut = {
        trID: pick(res.trID),
        StatusCode: pick(res.StatusCode),
        StatusText: pick(res.StatusText),
        remainAmt: pick(res.remainAmt) || undefined,
      };

      /* 필수 필드 검증 */
      if (!out.trID) {
        throw new Error('GiftiShow 응답 형식 오류 – trID 없음');
      }

      return out;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  async cancel(obj: GifitiShowCancelIn): Promise<void> {
    const headers = {
      api_code: '0101',
      custom_auth_code: this.corpCode,
      custom_auth_token: this.authToken,
      custom_enc_flag: 'N',
      'Content-Type': 'application/xml', // XML로 요청을 보내기 위한 Content-Type
      Accept: 'application/xml', // XML 응답을 수신하기 위함
    };
    const queryParams = new URLSearchParams({
      MDCODE: this.corpCode,
      tr_id: obj.transactionId,
    });

    const url = `${this.url}/media/coupon_cancel.asp?${queryParams.toString()}`;

    try {
      this.logger.log(url);
      this.logger.log(headers);
      const response = await firstValueFrom(this.httpService.get(url, { headers }));

      const result = response.data;

      const resultToJson = (await this.parser().parseStringPromise(result)) as unknown;

      this.logger.log(result);
      this.logger.log(resultToJson);
      // this.logger.log(response.toString());
      return;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }
}
