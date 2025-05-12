import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Parser } from 'xml2js';
import { firstValueFrom } from 'rxjs';
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
      this.url = 'https://api.gsmcoupon.gsmpp.com:32443'; // TODO prod URL 받으면 변경
    }
  }

  private logger = new Logger('GS_M_BIZ');

  private url: string = 'https://t-api.gsncoupon.co.kr';
  private cliCoCd: string = '';
  private encKey: string = '';
  private encIv: string = '';
  private cryptoAlgorithm = 'aes-256-cbc';

  private parser() {
    return new Parser();
  }

  async issue(obj: GsmBizIssueIn): Promise<GsmBizIssueOut> {
    const url = `${this.url}/services/standardWas/CouponIssue`;
    const headers = {};
    let dataStr = `Req_Div_Cd=01`;
    dataStr += `&Issu_Req_Val=${obj.partnerCompanyCode}`;
    dataStr += `&Clico_Issu_Paym_No=${obj.transactionId}`;
    dataStr += `&Clico_Issu_Paym_Seq=1`;
    dataStr += `&Cre_Cnt=1`;
    dataStr += `&Avl_Div_Cd=02`;
    dataStr += `&Avl_Start_Dy=`;
    dataStr += `&Avl_End_Dy=`;
    dataStr += `&Crd_Join_Yn=`;
    dataStr += `&Cmpn_Cd=${obj.transactionId}`;
    dataStr += `&Cust_No=`;

    this.logger.log('obj :::::::::::::::: ', obj);
    this.logger.log('dataStr :::::::::::::::: ', dataStr);
    const encrypt = this.cryptoCipher.gsmEncrypt(dataStr, this.encKey, this.encIv, this.cryptoAlgorithm);
    const data = new URLSearchParams({
      Clico_Cd: `${this.cliCoCd}`,
      EncStr: encrypt,
    });

    this.logger.log('encrypt :::::::::::::::: ', encrypt);

    try {
      const sendUrl = `${url}?${data.toString()}`;
      this.logger.log('sendUrl :::::::::::::::: ', sendUrl);

      const httpsAgent = new (require('https').Agent)({ rejectUnauthorized: false });

      const response = await firstValueFrom(
        this.httpService.get(sendUrl, {
          headers,
          httpsAgent,
        }),
      );
      const result = response.data;
      const resultToJson = (await this.parser().parseStringPromise(result)) as unknown as GsmBizIssueOut;

      this.logger.log(resultToJson);

      const barCode = this.cryptoCipher.gsmDecrypt(
        resultToJson.couponInfo.cupn_No,
        this.encKey,
        this.encIv,
        this.cryptoAlgorithm,
      );
      return { ...resultToJson, couponInfo: { ...resultToJson.couponInfo, barCode } };
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
