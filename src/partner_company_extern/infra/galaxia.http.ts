import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
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
      return {
        ...result,
        transactionId: this.cryptoCipher.decrypt(result.transactionId, this.encKey, this.encIv, this.cryptoAlgorithm),
        giftCertificate: {
          ...result.giftCertificate,

          issueNumber: this.cryptoCipher.decrypt(
            result.giftCertificate.issueNumber,
            this.encKey,
            this.encIv,
            this.cryptoAlgorithm,
          ),
          barcode: this.cryptoCipher.decrypt(
            result.giftCertificate.barcode,
            this.encKey,
            this.encIv,
            this.cryptoAlgorithm,
          ),
          faceValue: this.cryptoCipher.decrypt(
            result.giftCertificate.faceValue,
            this.encKey,
            this.encIv,
            this.cryptoAlgorithm,
          ),
        },
      } as GalaxiaIssueOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  async check(obj: GalaxiaCheckIn): Promise<GalaxiaCheckOut> {
    const kind = obj.paramKind ?? 0;
    const encrypted = this.cryptoCipher.encrypt(obj.paramValue, this.encKey, this.encIv, this.cryptoAlgorithm);

    // https://[SERVER_DOMAIN]/interface/mkt/{company-code}/{gift-kind}/{paramKind selected parameter(+)}
    const base = `${this.url}/interface/mkt/${this.companyCode}/${obj.giftKind}/${encrypted}`;
    const url = kind === 0 ? base : `${base}?paramKind=${kind}`;

    const headers = { Accept: 'application/json' };

    try {
      this.logger.log(url);

      const { data } = await firstValueFrom(this.httpService.get(url, { headers }));

      // 결과 복호화
      const parsed = data as GalaxiaCheckOut;

      return {
        ...parsed,
        transactionId: this.cryptoCipher.decrypt(parsed.transactionId, this.encKey, this.encIv, this.cryptoAlgorithm),
        giftCertificate: {
          ...parsed.giftCertificate,
          faceValue: this.cryptoCipher.decrypt(
            parsed.giftCertificate.faceValue,
            this.encKey,
            this.encIv,
            this.cryptoAlgorithm,
          ),
          balance: this.cryptoCipher.decrypt(
            parsed.giftCertificate.balance,
            this.encKey,
            this.encIv,
            this.cryptoAlgorithm,
          ),
        },
      };
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  async cancel(obj: GalaxiaCancelIn): Promise<void> {
    const url = `${this.url}/interface/mkt/${this.companyCode}/${obj.giftKind}/${this.cryptoCipher.encrypt(obj.transactionId, this.encKey, this.encIv, this.cryptoAlgorithm)}/cancel`;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    // const data = new URLSearchParams({
    //
    // });
    const body = {
      'order-number': obj.transactionId + 'C', // 거래 요청 번호
      issueDay: obj.sendRequestAt,
      paramKind: 1,
    };

    try {
      const sendUrl = `${url}`;
      this.logger.log(sendUrl);
      this.logger.log(headers);

      const response = await firstValueFrom(this.httpService.put(`${sendUrl}`, body, { headers }));

      this.logger.log(response.data);
      const result = response.data as GalaxiaIssueOut;

      if (result.resCode !== '0000') {
        throw new InternalServerErrorException('핀폐기가 실패했습니다.');
      }
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
