import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import {
  GalaxiaCancelIn,
  GalaxiaCheckIn,
  GalaxiaCheckOut,
  GalaxiaIssueIn,
  GalaxiaIssueOut,
  IGalaxia,
} from '../interface/galaxia';
import { Parser } from 'xml2js';

@Injectable()
export class GalaxiaHttp implements IGalaxia {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
    private cryptoCipher: CryptoCipher,
  ) {
    this.encKey = this.configService.getOrThrow('GALAXIA_ENCKEY');
    this.encIv = this.configService.getOrThrow('GALAXIA_ENCIV');
    if (this.configService.getOrThrow('ENVIRONMENT') === 'prod') {
      this.url = 'https://mcoupon.mdpt.co.kr';
    }
  }

  private logger = new Logger('GALAXIA');

  private companyCode: string = 'enmad';
  private encKey: string = '';
  private encIv: string = '';

  private url = 'https://mcoupon.mobilegift.co.kr'; // test URL
  private cryptoAlgorithm = 'aes-128-cbc';

  private parser() {
    return new Parser();
  }

  // 쿠폰 발행
  async issue(obj: GalaxiaIssueIn): Promise<GalaxiaIssueOut> {
    const callback = '16443614';
    const url = `${this.url}/interface/mkt/${this.companyCode}/${obj.giftKind}/issueCoupon`;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    const data = new URLSearchParams({
      'order-number': obj.transactionId, // 거래 요청 번호
      goodsGroupId: this.cryptoCipher.encrypt(obj.partnerCompanyCode, this.encKey, this.encIv, this.cryptoAlgorithm), // 발행 상품 코드
      buyer: this.cryptoCipher.encrypt(callback, this.encKey, this.encIv, this.cryptoAlgorithm),
      recipient: this.cryptoCipher.encrypt(obj.fromPhoneNumber, this.encKey, this.encIv, this.cryptoAlgorithm), // 수신자 핸드폰 번호
      saleType: 'B2B',
      saleChannel: 'enmad',
      duration: '0',
      'msg-type': 'LMS',
      'msg-callback': callback,
      dept: obj.giftKind, // coupon : cpn, 상품권 : dept
      sendMsg: 'N',
      // faceValue: obj.faceValue, // 발행 액면가
    });

    try {
      this.logger.log(`${url}?${data.toString()}`);
      this.logger.log(headers);

      const response = await firstValueFrom(this.httpService.post(`${url}?${data.toString()}`, {}, { headers }));

      this.logger.log(response.data);
      const result = response.data as GalaxiaIssueOut;

      // const resultToJson = (await this.parser().parseStringPromise(response.data)) as unknown as GalaxiaIssueOut;

      // this.logger.log(resultToJson);
      return result as GalaxiaIssueOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  async check(obj: GalaxiaCheckIn): Promise<GalaxiaCheckOut> {
    const url = `${this.url}/interface/mkt/${this.companyCode}/${obj.giftKind}/${this.cryptoCipher.encrypt(obj.trId, this.encKey, this.encIv, this.cryptoAlgorithm)}?paramKind=1`;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    try {
      this.logger.log(url);
      this.logger.log(headers);

      const response = await firstValueFrom(this.httpService.get(`${url}`, { headers }));

      this.logger.log(response.data);
      const result = response.data as GalaxiaCheckOut;

      // const resultToJson = (await this.parser().parseStringPromise(response.data)) as unknown as GalaxiaIssueOut;

      this.logger.log(JSON.stringify(result));
      return result as GalaxiaCheckOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  async cancel(obj: GalaxiaCancelIn): Promise<void> {
    const url = `${this.url}/interface/mkt/${this.companyCode}/${obj.giftKind}/${this.cryptoCipher.encrypt(obj.trId, this.encKey, this.encIv, this.cryptoAlgorithm)}/cancel`;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    const data = new URLSearchParams({
      'order-number': obj.transactionId, // 거래 요청 번호
    });

    try {
      const sendUrl = `${url}?${data.toString()}&issueDay=${obj.sendRequestAt}`;
      this.logger.log(sendUrl);
      this.logger.log(headers);

      const response = await firstValueFrom(this.httpService.put(`${sendUrl}`, {}, { headers }));

      this.logger.log(response.data);
      const result = response.data as GalaxiaIssueOut;

      // const resultToJson = (await this.parser().parseStringPromise(response.data)) as unknown as GalaxiaIssueOut;

      this.logger.log(JSON.stringify(result));
      // return result as GalaxiaIssueOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }
}
