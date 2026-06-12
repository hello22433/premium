import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ErpRequestIn } from '../interface/erp.request';
import { firstValueFrom } from 'rxjs';
import { ErpZoneExternOut } from '../interface/erp.zone.extern';
import { ErpLoginOut } from '../interface/erp.login.extern';
import { IErpExtern } from '../interface/erp.extern';
import { ErpProductListRequest, ErpProductDetailRequest } from '../interface/erp.product.request';
import { ErpProductListResponse } from '../interface/erp.product.response';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30분

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

  private sessionId = '';
  private zone = '';
  private expireAt = 0;
  private loginPromise: Promise<{ zone: string; sessionId: string }> | null = null;

  private saleUrl = 'https://oapi{ZONE}.ecount.com/OAPI/V2/Sale/SaveSale?SESSION_ID={SESSION_ID}';
  private productListUrl = 'https://oapi{ZONE}.ecount.com/OAPI/V2/InventoryBasic/GetBasicProductsList?SESSION_ID={SESSION_ID}';
  private productDetailUrl = 'https://oapi{ZONE}.ecount.com/OAPI/V2/InventoryBasic/ViewBasicProduct?SESSION_ID={SESSION_ID}';
  private zoneUrl = 'https://oapi.ecount.com/OAPI/V2/Zone';
  private loginUrl = 'https://oapi{ZONE}.ecount.com/OAPI/V2/OAPILogin';

  private async getSessionId(): Promise<{ zone: string; sessionId: string }> {
    if (this.sessionId && Date.now() < this.expireAt) {
      return { zone: this.zone, sessionId: this.sessionId };
    }

    if (!this.loginPromise) {
      this.loginPromise = this.performLogin().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  private async performLogin(): Promise<{ zone: string; sessionId: string }> {
    const zoneOut = await this.getZONE();
    const zone = zoneOut.Data.ZONE;
    const loginOut = await this.login(zone);
    const sessionId = loginOut.Data.Datas.SESSION_ID;

    this.zone = zone;
    this.sessionId = sessionId;
    this.expireAt = Date.now() + SESSION_TTL_MS;

    return { zone, sessionId };
  }

  private buildUrl(template: string, zone: string, sessionId: string): string {
    return template.replace('{ZONE}', zone).replace('{SESSION_ID}', sessionId);
  }

  private invalidateSession() {
    this.sessionId = '';
    this.expireAt = 0;
  }

  private async callErpApi<T>(urlTemplate: string, body: unknown): Promise<T> {
    try {
      const { zone, sessionId } = await this.getSessionId();
      const url = this.buildUrl(urlTemplate, zone, sessionId);
      const response = await firstValueFrom(this.httpService.post(url, body, {}));
      return response.data as T;
    } catch (e) {
      this.invalidateSession();
      this.logger.error(e);
      throw e;
    }
  }

  async issue(obj: ErpRequestIn) {
    const result = await this.callErpApi(this.saleUrl, obj);
    this.logger.log(result);
  }

  async getProductsList(req: ErpProductListRequest): Promise<ErpProductListResponse> {
    const result = await this.callErpApi<ErpProductListResponse>(this.productListUrl, req);
    if (Number(result.Status) !== 200) {
      this.logger.error(JSON.stringify(result));
      this.invalidateSession();
      throw new Error('ERP 품목 목록 조회 실패');
    }
    return result;
  }

  async getProduct(req: ErpProductDetailRequest): Promise<ErpProductListResponse> {
    const result = await this.callErpApi<ErpProductListResponse>(this.productDetailUrl, req);
    if (Number(result.Status) !== 200) {
      this.logger.error(JSON.stringify(result));
      this.invalidateSession();
      throw new Error('ERP 품목 단건 조회 실패');
    }
    return result;
  }

  private async getZONE(): Promise<ErpZoneExternOut> {
    try {
      const data = { COM_CODE: this.comCode };
      const response = await firstValueFrom(this.httpService.post(this.zoneUrl, data, {}));
      const result = response.data;
      this.logger.log(result);
      return result as ErpZoneExternOut;
    } catch (e) {
      this.logger.error(e);
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
      const response = await firstValueFrom(this.httpService.post(url, data, {}));
      const result = response.data as ErpLoginOut;

      if (Number(result.Status) !== 200) {
        this.logger.error(JSON.stringify(result));
        throw new Error('erp 로그인 실패');
      }

      if (result.Data.Code !== '00') {
        this.logger.error(JSON.stringify(result));
        throw new Error('erp 로그인 실패');
      }

      this.logger.log(result);
      return result;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }
}
