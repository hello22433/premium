import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

import { firstValueFrom } from 'rxjs';
import {
  GiftielCancelIn,
  GiftielCheckIn,
  GiftielCheckOut,
  GiftielIssueIn,
  GiftielIssueOut,
  IGiftiel,
} from '../interface/giftiel';

@Injectable()
export class GiftielHttp implements IGiftiel {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.ciCode = this.configService.getOrThrow('GIFIEL_CI_CODE');
    this.ciPwd = this.configService.getOrThrow('GIFIEL_CI_PWD');

    if (this.configService.getOrThrow('ENVIRONMENT') === 'prod') {
      this.url = 'https://serviceapi.giftiel.co.kr';
    }
  }

  private logger = new Logger('GIFTIEL');

  private ciCode: string = '';
  private ciPwd: string = '';

  private url = 'https://tserviceapi.giftiel.kr'; // test URL

  async issue(obj: GiftielIssueIn): Promise<GiftielIssueOut> {
    const url = `${this.url}/Api/Coupon/CouponProcessJson.asmx/GetCouponNumber`;
    const headers = {
      'Content-Type': 'application/json',
    };

    const data = {
      CiCode: this.ciCode,
      CiPwd: this.ciPwd,
      CouponCode: obj.partnerCompanyCode,
      CreateCnt: 1,
      SeqNumber: obj.transactionId,
      SendYn: 'N',
      SendHp: '01000000000',
    };

    try {
      this.logger.log(url);
      this.logger.log(data);
      this.logger.log(headers);
      const response = await firstValueFrom(this.httpService.post(url, data, { headers }));

      const result = response.data;
      this.logger.log(result);
      return result as GiftielIssueOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  async check(obj: GiftielCheckIn): Promise<GiftielCheckOut> {
    const url = `${this.url}/Api/Coupon/CouponInfomationJson.asmx/GetCouponCondition`;
    const headers = { 'Content-Type': 'application/json' };

    const payload = {
      CiCode: this.ciCode,
      CiPwd: this.ciPwd,
      CouponCode: obj.partnerCompanyCode,
      CouponNum: obj.barCode,
    };

    try {
      this.logger.log('[Giftiel] GET-COUPON-CONDITION ▶', url, payload);

      const { data } = await firstValueFrom(this.httpService.post(url, payload, { headers }));

      if (!data?.ResultCode) {
        this.logger.error('비정상 응답 형식 – ResultCode 없음', data);
        throw new Error('Giftiel Response Error: ResultCode is missing');
      }

      if (data.ResultCode !== '0000') {
        throw new Error(`Giftiel Response Error: ${data.ResultCode} – ${data.ResultMsg}`);
      }

      const safe = (k: keyof GiftielCheckOut) => (data[k] as string | undefined) ?? '';

      const result: GiftielCheckOut = {
        ResultCode: data.ResultCode,
        ResultMsg: data.ResultMsg,

        CouponNum: safe('CouponNum'),
        CnName: safe('CnName'),
        CnPrice: safe('CnPrice'),
        AccountYn: safe('AccountYn') as 'Y' | 'C',
        SendGubun: safe('SendGubun') as 'B' | 'C' | 'O',
        UseYn: safe('UseYn') as 'Y' | 'N',
        UseDate: safe('UseDate'),
        BiName: safe('BiName'),
        IsCancel: safe('IsCancel') as 'Y' | 'N',
        DayStart: safe('DayStart'),
        DayEnd: safe('DayEnd'),
        CouponType: safe('CouponType') as '00' | '02',
        CouponBalance: safe('CouponBalance'),
        BalChkUrl: safe('BalChkUrl'),
      };

      return result;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  async cancel(obj: GiftielCancelIn): Promise<void> {
    const url = `${this.url}/Api/Coupon/CouponProcessJson.asmx/SetCouponCancel`;
    const headers = {
      'Content-Type': 'application/json',
    };

    const data = {
      CiCode: this.ciCode,
      CiPwd: this.ciPwd,
      CouponCode: obj.partnerCompanyCode,
      CancelState: '1',
      Value: obj.barCode,
    };

    try {
      this.logger.log(url);
      this.logger.log(data);
      this.logger.log(headers);
      const response = await firstValueFrom(this.httpService.post(url, data, { headers }));

      const result = response.data;
      this.logger.log(result);

      if (!result?.ResultCode) {
        throw new Error('[GIFTIEL] 비정상 응답: ResultCode 없음');
      }
      if (result.ResultCode === '0000') {
        return;
      }

      // 0219: 이미 취소처리된 쿠폰번호 → check 로 멱등 검증
      if (result.ResultCode === '0219') {
        await this.verifyCancelIdempotent(obj, `0219: ${result.ResultMsg}`);
        return;
      }

      throw new Error(`[GIFTIEL:${result.ResultCode}] ${result.ResultMsg}`);
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  /**
   * cancel 0219(이미 취소처리된 쿠폰번호) 응답 검증.
   * check 로 IsCancel='Y' 인지 확인하여 멱등 처리한다.
   * (Giftiel check 는 ResultCode 가 0000 이 아니면 throw 하므로 try/catch 로 감싸지 않음)
   */
  private async verifyCancelIdempotent(obj: GiftielCancelIn, reason: string): Promise<void> {
    this.logger.warn(`[cancel] 이미 취소 시그널(${reason}) - check 로 검증. barCode: ${obj.barCode}`);
    const checkResult = await this.check({
      partnerCompanyCode: obj.partnerCompanyCode,
      barCode: obj.barCode,
    });
    if (checkResult.IsCancel === 'Y') {
      this.logger.warn(`[cancel] check 결과 IsCancel=Y 확인 - 멱등 처리. barCode: ${obj.barCode}`);
      return;
    }
    throw new Error(
      `[GIFTIEL] cancel 이미 취소 응답(${reason})이나 check IsCancel=${checkResult.IsCancel} - barCode: ${obj.barCode}`,
    );
  }
}
