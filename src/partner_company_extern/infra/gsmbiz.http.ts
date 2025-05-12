import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Parser } from 'xml2js';
import { firstValueFrom } from 'rxjs';
import * as https from 'https';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import {
  GsmBizCancelIn,
  GsmBizCheckIn,
  GsmBizCheckOut,
  GsmBizIssueIn,
  GsmBizIssueOut,
  IGsmbiz,
} from '../interface/gsmbiz';

@Injectable()
export class GsmbizHttp implements IGsmbiz {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
    private cryptoCipher: CryptoCipher,
  ) {
    this.cliCoCd = this.configService.getOrThrow('GS_M_BIZ_CLICO_CD');
    this.encKey = this.configService.getOrThrow('GS_M_BIZ_ENCKEY');
    this.encIv = this.configService.getOrThrow('GS_M_BIZ_ENCIV');
    if (this.configService.getOrThrow('ENVIRONMENT') === 'prod') {
      this.url = 'https://api.gsmcoupon.gsmpp.com:32443';
    }
  }

  private logger = new Logger('GS_M_BIZ');

  private url: string = 'https://t-api.gsncoupon.co.kr';
  private cliCoCd: string = '';
  private encKey: string = '';
  private encIv: string = '';
  private cryptoAlgorithm = 'aes-256-cbc';

  private parser = new Parser();

  async issue(obj: GsmBizIssueIn): Promise<GsmBizIssueOut> {
    const baseUrl = `${this.url}/services/standardWas/CouponIssue`;

    // 암호화할 평문 생성
    const dataStr = [
      'Req_Div_Cd=01',
      `Issu_Req_Val=${obj.partnerCompanyCode}`,
      `Clico_Issu_Paym_No=${obj.transactionId}`,
      'Clico_Issu_Paym_Seq=1',
      'Cre_Cnt=1',
      'Avl_Div_Cd=02'
    ].join('&');

    const encrypted = this.cryptoCipher.gsmEncrypt(dataStr, this.encKey, this.encIv, this.cryptoAlgorithm);
    const sendUrl = `${baseUrl}?Clico_Cd=${this.cliCoCd}&EncStr=${encodeURIComponent(encrypted)}`;
    
    try {
      const httpsAgent = new https.Agent({ rejectUnauthorized: false });
      const response = await firstValueFrom(
        this.httpService.get(sendUrl, {
          httpsAgent,
          responseType: 'text',
        }),
      );

      const parsed = await this.parser.parseStringPromise(response.data);

      const returnData =
        parsed?.['soapenv:Envelope']?.['soapenv:Body']?.[0]?.['dlwmin:CouponIssueResponse']?.[0]?.['return']?.[0];

      if (!returnData?.couponInfo?.[0]) {
        this.logger.error('couponInfo 누락됨:', returnData);
        throw new Error('couponInfo 파싱 실패');
      }

      const couponInfo = returnData.couponInfo[0];
      const cupn_No = couponInfo.cupn_No?.[0];
      const avlStart_Dy = couponInfo.avl_Start_Dy?.[0] || '';
      const avl_End_Dy = couponInfo.avl_End_Dy?.[0] || '';
      const appr_Url = couponInfo.appr_Url?.[0] || '';

      const barCode = this.cryptoCipher.gsmDecrypt(cupn_No, this.encKey, this.encIv, this.cryptoAlgorithm);

      return {
        returnCode: returnData.returnCode?.[0] || '',
        returnMsg: returnData.returnMsg?.[0] || '',
        couponInfo: {
          cupn_No,
          avlStart_Dy,
          avl_End_Dy,
          appr_Url,
          barCode,
        },
      };
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  async check(obj: GsmBizCheckIn): Promise<GsmBizCheckOut> {
    const url = `${this.url}/services/standardWas/CouponSearch`;
    const headers = {};
    let dataStr = `Req_Div_Cd=01`;
    dataStr += `&Issu_Req_Val=${obj.partnerCompanyCode}`;
    dataStr += `&Search_Div=02`;
    dataStr += `&Receive_Div=99`;
    dataStr += `&Cupn_No=${obj.barCode}`;
    dataStr += `&Clico_Issu_Paym_No=${obj.transactionId}`;
    dataStr += `&Clico_Issu_Paym_Seq=1`;

    const encrypt = this.cryptoCipher.gsmEncrypt(dataStr, this.encKey, this.encIv, this.cryptoAlgorithm);
    const data = new URLSearchParams({
      Clico_Cd: `${this.cliCoCd}`,
      EncStr: encrypt,
    });

    try {
      const sendUrl = `${url}?${data.toString()}`;
      const response = await firstValueFrom(this.httpService.get(`${sendUrl}`, { headers }));
      const result = response.data;
      const resultToJson = (await this.parser().parseStringPromise(result)) as unknown as GsmBizCheckOut;

      this.logger.log(result);
      this.logger.log(resultToJson);

      // STATE
      // 00: 취소 가능 쿠폰
      // 10: 사용된 쿠폰,
      // 11: 미결제 쿠폰,
      // 12: 이미 취소된 쿠폰
      // 14: 사용가능 유효기간 초과
      return { ...resultToJson, couponInfo: { ...resultToJson.couponInfo } };
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  async cancel(obj: GsmBizCancelIn): Promise<void> {
    const url = `${this.url}/services/standardWas/CouponCancel`;
    const headers = {};
    let dataStr = `Req_Div_Cd=01`;
    dataStr += `&Issu_Req_Val=${obj.partnerCompanyCode}`;
    dataStr += `&Cncl_Req_Div=02`;
    dataStr += `&Cupn_No=${obj.barCode}`;
    dataStr += `&Clico_Issu_Paym_No=${obj.transactionId}`;
    dataStr += `&Clico_Issu_Paym_Seq=1`;

    const encrypt = this.cryptoCipher.gsmEncrypt(dataStr, this.encKey, this.encIv, this.cryptoAlgorithm);
    const data = new URLSearchParams({
      Clico_Cd: `${this.cliCoCd}`,
      EncStr: encrypt,
    });

    try {
      const sendUrl = `${url}?${data.toString()}`;
      const response = await firstValueFrom(this.httpService.get(`${sendUrl}`, { headers }));
      const result = response.data;
      const resultToJson = (await this.parser().parseStringPromise(result)) as unknown;

      this.logger.log(result);
      this.logger.log(resultToJson);

      // return { ...resultToJson, couponInfo: { ...resultToJson.couponInfo, barCode } };
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }
}
