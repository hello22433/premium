import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ErpRequestIn } from '../interface/erp.request';
import { firstValueFrom } from 'rxjs';
import { ErpZoneExternOut } from '../interface/erp.zone.extern';
import { ErpLoginOut } from '../interface/erp.login.extern';
import { IErpExtern } from '../interface/erp.extern';

class ErpLoginObject {
  static sessionId = '';
  static expireAt: number = 0;
}

@Injectable()
export class ErpExternHttp implements IErpExtern {
  private logger = new Logger('ERP');

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.comCode = this.configService.getOrThrow('ERP_COM_CODE');
    this.userId = this.configService.getOrThrow('ERP_USER_ID');
    this.apiCertKey = this.configService.getOrThrow('ERP_API_CERT_KEY');
  }

  private comCode = '';
  private userId = '';
  private apiCertKey = '';

  // https://oapi{ZONE}.ecount.com/OAPI/V2/Sale/SaveSale?SESSION_ID={SESSION_ID}
  private url = 'https://oapi{ZONE}.ecount.com/OAPI/V2/Sale/SaveSale?SESSION_ID={SESSION_ID}';
  private zoneUrl = 'https://oapi.ecount.com/OAPI/V2/Zone';
  private loginUrl = 'https://oapi{ZONE}.ecount.com/OAPI/V2/OAPILogin';

  async issue(obj: ErpRequestIn) {
    const data = JSON.parse(JSON.stringify(obj));

    try {
      const zoneOut = await this.getZONE();
      const zone = zoneOut.Data.ZONE;
      const loginOut = await this.login(zone);

      const sessionId = loginOut.Data.Datas.SESSION_ID;

      const url = this.url.replace('{ZONE}', zone).replace('{SESSION_ID}', sessionId);
      // 판매 입력 API 요청
      const response = await firstValueFrom(this.httpService.post(url, data, {}));

      const result = response.data;
      this.logger.log(result);
      // return result as GiftielIssueOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  private async getZONE(): Promise<ErpZoneExternOut> {
    try {
      const url = this.zoneUrl;
      const data = {
        COM_CODE: this.comCode,
      };
      // 판매 입력 API 요청
      const response = await firstValueFrom(this.httpService.post(url, data, {}));

      const result = response.data;
      this.logger.log(result);
      return result as ErpZoneExternOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  private async login(zone: string): Promise<ErpLoginOut> {
    try {
      const url = this.loginUrl.replace('{ZONE}', zone);
      const data = {
        COM_CODE: this.comCode,
        USER_ID: this.userId,
        API_CERT_KEY: this.apiCertKey,
        LAN_TYPE: 'ko-KR',
        ZONE: zone,
      };
      // 판매 입력 API 요청
      const response = await firstValueFrom(this.httpService.post(url, data, {}));

      const result = response.data as ErpLoginOut;
      if (result.Status != '200') {
        this.logger.error(JSON.stringify(result));
        throw new Error('erp 로그인 실패');
      }

      if (result.Data.Code !== '00') {
        this.logger.error(JSON.stringify(result));
        throw new Error('erp 로그인 실패');
      }
      this.logger.log(result);
      return result as ErpLoginOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }
}

// 예시 json
// {
//   "SaleOrderList": [
//   {
//     "BulkDatas": {
//       "U_MEMO1": "김고객",
//       "CUST_DES": "큰고객사",
//       "WH_CD": "02",
//       "U_MEMO4": "큰이벤트",
//       "TIME_DATE": "20250324",
//       "ADD_TXT_10_T": "이벤트상세",
//       "U_TXT1": "특이사항",
//       "PROD_CD": "00002",
//       "REMARKS": "큰브랜드명",
//       "P_REMARKS1": "큰공급처",
//       "PROD_DES": "큰품목명",
//       "QTY": "10",
//       "PRICE": "10000",
//       "SUPPLY_AMT": "100000",
//       "P_REMARKS2": "김담당"
//     }
//   },
//   {
//     "BulkDatas": {
//       "U_MEMO1": "이고객",
//       "CUST_DES": "작은고객사",
//       "WH_CD": "02",
//       "U_MEMO4": "작은이벤트",
//       "TIME_DATE": "20250324",
//       "ADD_TXT_10_T": "이벤트상세",
//       "U_TXT1": "특이사항",
//       "PROD_CD": "00002",
//       "REMARKS": "작은브랜드명",
//       "P_REMARKS1": "작은공급처",
//       "PROD_DES": "작은품목명",
//       "QTY": "10",
//       "PRICE": "10000",
//       "SUPPLY_AMT": "100000",
//       "P_REMARKS2": "이담당"
//     }
//   }
// ]
// }
