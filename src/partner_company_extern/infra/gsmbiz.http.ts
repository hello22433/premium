import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Parser } from 'xml2js';
import { firstValueFrom } from 'rxjs';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { GsmBizIssueIn, GsmBizIssueOut, IGsmbiz } from '../interface/gsmbiz';

@Injectable()
export class GsmbizHttp implements IGsmbiz {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
    private cryptoCipher: CryptoCipher,
  ) {
    this.encKey = this.configService.getOrThrow('GS_M_BIZ_ENCKEY');
    this.encIv = this.configService.getOrThrow('GS_M_BIZ_ENCIV');
    if (this.configService.getOrThrow('ENVIRONMENT') === 'prod') {
      this.url = 'https://t-api.gsncoupon.co.kr'; // TODO prod URL 받으면 변경
    }
  }
  private logger = new Logger('GS_M_BIZ');

  private url: string = 'https://t-api.gsncoupon.co.kr';
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
    dataStr += `&Cre_Cnt=1`;

    const encrypt = this.cryptoCipher.encrypt(dataStr, this.encKey, this.encIv, this.cryptoAlgorithm);
    const data = new URLSearchParams({
      Clico_Cd: '0000',
      EncStr: encrypt,
    });

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${url}/services/standardWas/CouponIssue?${data.toString()}`, { headers }),
      );
      const result = response.data;
      const resultToJson = (await this.parser().parseStringPromise(result)) as unknown as GsmBizIssueOut;

      this.logger.log(resultToJson);

      const barCode = this.cryptoCipher.decrypt(
        resultToJson.couponInfo.cupn_No,
        this.encKey,
        this.encIv,
        this.cryptoAlgorithm,
      );
      return { ...resultToJson, couponInfo: { ...resultToJson.couponInfo, barCode } };
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }
}
