import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { firstValueFrom } from 'rxjs';
import { GiftielIssueIn, GiftielIssueOut, IGiftiel } from '../interface/giftiel';

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

  private url = 'http://tserviceapi.giftiel.kr'; // test URL

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
      const response = await firstValueFrom(this.httpService.post(url, data, { headers }));

      const result = response.data;
      this.logger.log(result);
      return result as GiftielIssueOut;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }
}
