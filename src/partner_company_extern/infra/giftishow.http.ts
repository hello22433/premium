import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

import { firstValueFrom } from 'rxjs';
import { Parser } from 'xml2js';
import {
  GifitiShowCancelIn,
  GifitiShowCheckIn,
  GiftiShowAllGoodsOut,
  GiftiShowCheckOut,
  GiftiShowCouponInfo,
  GiftiShowIssueIn,
  GiftiShowIssueOut,
  IGiftiShow,
} from '../interface/giftishow';

@Injectable()
export class GiftishowHttp implements IGiftiShow {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
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
    // V2 API 헤더
    const headers = {
      api_code: '0451',
      custom_auth_code: this.corpCode,
      custom_auth_token: this.authToken,
      custom_enc_flag: 'N',
      Accept: 'application/json',
    };

    // tr_id 또는 pin_no로 조회
    const queryParams = new URLSearchParams();
    if (obj.transactionId) {
      queryParams.set('tr_id', obj.transactionId);
    } else if (obj.pinNo) {
      queryParams.set('pin_no', obj.pinNo);
    } else {
      throw new Error('transactionId 또는 pinNo 중 하나는 필수입니다.');
    }

    const url = `${this.url}/coupon?${queryParams.toString()}`;
    this.logger.log('[GiftiShow V2] coupon check → ', url);

    try {
      const { data } = await firstValueFrom(this.httpService.get(url, { headers }));

      this.logger.log('[GiftiShow V2] response:', JSON.stringify(data));

      // JSON 응답 파싱
      const resCode = data.resCode;
      const resMsg = data.resMsg;

      let couponInfo: GiftiShowCouponInfo | undefined;
      if (data.couponInfoList && data.couponInfoList.length > 0) {
        const info = data.couponInfoList[0];
        couponInfo = {
          pinNo: info.pinNo,
          pinStatusCd: info.pinStatusCd,
          pinStatusNm: info.pinStatusNm,
          goodsNm: info.goodsNm,
          brandNm: info.brandNm,
          branchNm: info.branchNm,
          tradeBranchNm: info.tradeBranchNm,
          useComNm: info.useComNm,
          remainAmt: info.remainAmt,
          exchDtm: info.exchDtm,
          apprvDtm: info.apprvDtm,
          cancelDtm: info.cancelDtm,
          validPrdEndDt: info.validPrdEndDt,
        };
      }

      const out: GiftiShowCheckOut = {
        resCode,
        resMsg,
        couponInfo,
      };

      return out;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  async getAllGoods(): Promise<GiftiShowAllGoodsOut> {
    const headers = {
      api_code: '0101',
      custom_auth_code: this.corpCode,
      custom_auth_token: this.authToken,
      custom_enc_flag: 'N',
      Accept: 'application/json',
    };

    const url = `${this.url}/goods`;

    try {
      this.logger.log('[GiftiShow] getAllGoods → ', url);
      const { data } = await firstValueFrom(this.httpService.get(url, { headers }));

      this.logger.log(`[GiftiShow] getAllGoods response: listNum=${data.listNum}`);

      return { ...data, goodsList: data.goodsList ?? [] };
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
      'Content-Type': 'application/xml',
      Accept: 'application/xml',
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

      const resultToJson = (await this.parser().parseStringPromise(result)) as {
        response: { result: Array<{ StatusCode: string[]; StatusText: string[] }> };
      };

      this.logger.log(result);
      this.logger.log(resultToJson);
      const statusCode = resultToJson.response?.result?.[0]?.StatusCode?.[0];
      const statusText = resultToJson.response?.result?.[0]?.StatusText?.[0];
      if (statusCode === '0') {
        return;
      }

      // cancel 실패 → check 로 멱등 검증 (pinStatusCd=07 이면 이미 취소된 쿠폰)
      await this.verifyCancelIdempotent(obj, `${statusCode}: ${statusText}`);
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  /**
   * cancel 실패 응답 검증.
   * check 로 V2 pinStatusCd 가 '07'(취소) 인지 확인하여 멱등 처리한다.
   */
  private async verifyCancelIdempotent(obj: GifitiShowCancelIn, reason: string): Promise<void> {
    this.logger.warn(
      `[cancel] 에러(${reason}) - check 로 멱등 검증. transactionId: ${obj.transactionId}`,
    );
    const checkResult = await this.check({ transactionId: obj.transactionId });
    if (checkResult.couponInfo?.pinStatusCd === '07') {
      this.logger.warn(
        `[cancel] check 결과 pinStatusCd=07 (취소) 확인 - 멱등 처리. transactionId: ${obj.transactionId}`,
      );
      return;
    }
    throw new Error(
      `[GIFT_SHOW] cancel 에러(${reason})이나 check pinStatusCd=${checkResult.couponInfo?.pinStatusCd ?? 'undefined'} - transactionId: ${obj.transactionId}`,
    );
  }
}
