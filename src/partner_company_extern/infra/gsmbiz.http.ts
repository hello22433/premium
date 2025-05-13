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

  private parser = new Parser({ explicitArray: false, ignoreAttrs: true });

  async issue(obj: GsmBizIssueIn): Promise<GsmBizIssueOut> {
    const baseUrl = `${this.url}/services/standardWas/CouponIssue`;
    const headers = {};

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
    const sendUrl = `${baseUrl}?Clico_Cd=${this.cliCoCd}&EncStr=${encrypted}`;
    
    this.logger.log('issue() sendUrl ::::::::::::' + sendUrl);

    try {
      const httpsAgent = new https.Agent({ rejectUnauthorized: false });
      const response = await firstValueFrom(
        this.httpService.get(sendUrl, {
          headers,
          httpsAgent,
          responseType: 'text',
        }),
      );

      this.logger.log('issue() response.data ::::::::::::' + response.data);

      const parsed = await this.parser.parseStringPromise(response.data);
      const returnData = parsed['dlwmin:CouponIssueResponse']?.return;
      const cupn_No = returnData?.couponInfo?.cupn_No ?? '';
      const returnCode = returnData?.returnCode ?? '';
      const returnMsg = returnData?.returnMsg ?? '';

      if (!cupn_No || returnCode !== '00000') {
        this.logger.error('필수 정보 누락 또는 실패:', returnData);
        throw new Error(`발급 실패: ${returnCode} - ${returnMsg}`);
      }

      const barCode = this.cryptoCipher.gsmDecrypt(cupn_No, this.encKey, this.encIv, this.cryptoAlgorithm);

      return {
        returnCode,
        returnMsg,
        couponInfo: {
          cupn_No,
          avlStart_Dy: returnData.couponInfo?.avl_Start_Dy ?? '',
          avl_End_Dy: returnData.couponInfo?.avl_End_Dy ?? '',
          appr_Url: returnData.couponInfo?.appr_Url ?? '',
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
    const baseUrl = `${this.url}/services/standardWas/CouponSearch`;
    const headers = {};

    const dataStr = [
      'Req_Div_Cd=01',
      `Issu_Req_Val=${obj.partnerCompanyCode}`,
      'Search_Div=02',
      'Receive_Div=99',
      `Cupn_No=${obj.barCode}`,
      `Clico_Issu_Paym_No=${obj.transactionId}`,
      'Clico_Issu_Paym_Seq=1',
    ].join('&');

    const encrypted = this.cryptoCipher.gsmEncrypt(dataStr, this.encKey, this.encIv, this.cryptoAlgorithm);
    const sendUrl = `${baseUrl}?Clico_Cd=${this.cliCoCd}&EncStr=${encrypted}`;

    this.logger.log('check() sendUrl :::::::::::::::: ', sendUrl);

    try {
      const httpsAgent = new https.Agent({ rejectUnauthorized: false });
      const response = await firstValueFrom(
        this.httpService.get(sendUrl, {
          headers,
          httpsAgent,
          responseType: 'text',
        }),
      );

      this.logger.log('check() response.data ::::::::::::' + response.data);

      const parsed = await this.parser.parseStringPromise(response.data);
      const returnData = parsed['dlwmin:CouponSearchResponse']?.return;
      const returnCode = returnData?.returnCode ?? '';
      const returnMsg = returnData?.returnMsg ?? '';
      const encOut = returnData?.encOut ?? '';

      if (!encOut) {
        this.logger.error('encOut 누락됨:', returnData);
        throw new Error('GSMBIZ check 응답에 encOut 없음');
      }

      const decrypted = this.cryptoCipher.gsmDecrypt(encOut, this.encKey, this.encIv, this.cryptoAlgorithm);

      const parsedMap = Object.fromEntries(
        decrypted.split('&').map((pair) => {
          const [key, value] = pair.split('=');
          return [key.trim(), value?.trim() ?? ''];
        }),
      );

      return {
        returnCode,
        returnMsg,
        couponInfo: {
          STATE: parsedMap.STATE || '',
          cupn_No: parsedMap.cupn_No || '',
          avlStart_Dy: parsedMap.avlStart_Dy || '',
          avl_End_Dy: parsedMap.avl_End_Dy || '',
          appr_Url: parsedMap.appr_Url || '',
          barCode: obj.barCode,
          USE_DT: parsedMap.USE_DT || '',
        },
      };
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }



  async cancel(obj: GsmBizCancelIn): Promise<void> {
    const baseUrl = `${this.url}/services/standardWas/CouponCancel`;
    const headers = {};

    // 암호화할 평문 생성
    const dataStr = [
      'Req_Div_Cd=01',
      `Issu_Req_Val=${obj.partnerCompanyCode}`,
      `Cncl_Req_Div=02`,
      `Cupn_No=${obj.barCode}`,
      `Clico_Issu_Paym_No=${obj.transactionId}`,
      'Clico_Issu_Paym_Seq=1'
    ].join('&');

    const encrypted = this.cryptoCipher.gsmEncrypt(dataStr, this.encKey, this.encIv, this.cryptoAlgorithm);
    const sendUrl = `${baseUrl}?Clico_Cd=${this.cliCoCd}&EncStr=${encrypted}`;

    this.logger.log('cancel() sendUrl ::::::::::::' + sendUrl);

    try {
      const httpsAgent = new https.Agent({ rejectUnauthorized: false });
      const response = await firstValueFrom(
        this.httpService.get(sendUrl, {
          headers,
          httpsAgent,
          responseType: 'text',
        }),
      );

      this.logger.log('cancel() response.data ::::::::::::' + response.data);

      const parsed = await this.parser.parseStringPromise(response.data);
      const returnData = parsed['dlwmin:CouponCancelResponse']?.return;
      
      if (!returnData) {
        this.logger.error('CouponCancel 응답 파싱 실패:', parsed);
        throw new Error('응답 파싱 실패');
      }

      const returnCode = returnData?.returnCode ?? '';
      const returnMsg = returnData?.returnMsg ?? '';
      const encOut = returnData?.encOut ?? '';

      if (returnCode !== '00000') {
        throw new Error(`취소 실패: ${returnCode} - ${returnMsg}`);
      }

      // 복호화된 내용 안에서 Issu_Cncl_Dt 파싱 필요 시
      const decrypted = this.cryptoCipher.gsmDecrypt(encOut, this.encKey, this.encIv, this.cryptoAlgorithm);
      this.logger.log('복호화 결과:', decrypted);

      // 예: YYYYMMDDhhmiss 형식 추출
      const match = decrypted.match(/Issu_Cncl_Dt=(\d{14})/);
      const cancelDate = match?.[1];

      this.logger.log(`Coupon cancelled at: ${cancelDate}`);
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

}
