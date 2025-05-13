import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
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
    private cryptoCipher: CryptoCipher,
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
    const headers = {
      'Content-Type': 'application/json',
    };

    const data = {
      CiCode: this.ciCode,
      CiPwd: this.ciPwd,
      CouponCode: obj.transactionId,
      CouponNum: obj.barCode,
    };

    try {
      this.logger.log(url);
      this.logger.log(data);
      this.logger.log(headers);
      const response = await firstValueFrom(this.httpService.post(url, data, { headers }));

      const result = response.data;
      this.logger.log(result);
      return result as GiftielCheckOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
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
      CouponCode: obj.transactionId,
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
      return;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }
}
