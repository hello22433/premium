import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { GalaxiaIssueIn, GalaxiaIssueOut, IGalaxia } from '../interface/galaxia';

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
      return response.data as GalaxiaIssueOut;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }
}
