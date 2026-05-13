import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as https from 'https';
import {
  DaouCancelIn,
  DaouCancelOut,
  DaouCheckIn,
  DaouCheckOut,
  DaouGoodsInfoItem,
  DaouGoodsInfoOut,
  DaouIssueIn,
  DaouIssueOut,
  IDaou,
} from '../interface/daou';
import { DaouXmlParser } from '../utils/daou.xml.parser';
import { format, addDays } from 'date-fns';

@Injectable()
export class DaouHttp implements IDaou {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.siteId = this.configService.getOrThrow<string>('PIN_DAOU_SITEID');
    this.cooperId = this.configService.getOrThrow<string>('PIN_DAOU_COOPERID');
    this.cooperPw = this.configService.getOrThrow<string>('PIN_DAOU_COOPERPW');

    // 운영 환경일 때 URL 변경
    if (this.configService.getOrThrow('ENVIRONMENT') === 'prod') {
      this.baseUrl = 'https://atom.donutbook.co.kr/b2ccoupon/b2cservice.aspx?ACTION=';
    }
  }

  private logger = new Logger('DAOU');
  private xmlParser = new DaouXmlParser();

  // URL 설정
  private baseUrl: string = 'https://stg-atom.donutbook.co.kr/b2ccoupon/b2cService.aspx?ACTION=';

  // 환경변수에서 가져온 설정값
  private siteId: string;
  private cooperId: string;
  private cooperPw: string;

  // ACTION 파라미터 값들
  private readonly ACTION_ISSUE = 'CI112_ONLY_ISSUECPN_WITHPAY'; // 쿠폰 발급
  private readonly ACTION_CANCEL = 'CI104_DISUSECPN'; // 쿠폰 취소
  private readonly ACTION_CHECK = 'CI07113_QUERY_COOPERORDER_WITHPAY'; // 쿠폰 상태 조회 (COOPER_ORDER 기준)
  private readonly ACTION_CHECK_NOCPN = 'CI06_QUERY_NOCPN'; // 쿠폰 상태 조회 (NO_CPN 기준)
  private readonly ACTION_GOODS_INFO = 'CC01_DOWN_ALL_GOODSINFO'; // 전체 상품 정보 조회 (GET)

  /**
   * TLS 1.2를 사용하는 HTTPS Agent 생성
   * Java의 SSLContext.getInstance("TLSv1.2") 와 동일한 역할
   */
  private createHttpsAgent(): https.Agent {
    return new https.Agent({
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      rejectUnauthorized: false,
    });
  }

  /**
   * 유효기간 종료일 계산
   * @param startDate YYYYMMDD 형식의 시작일
   * @param limitDays 유효기간 (일수)
   * @returns YYYYMMDD 형식의 종료일
   */
  private calculateLimitEndDate(startDate: string, limitDays: string): string {
    const year = parseInt(startDate.substring(0, 4));
    const month = parseInt(startDate.substring(4, 6)) - 1;
    const day = parseInt(startDate.substring(6, 8));

    const date = new Date(year, month, day);
    const endDate = addDays(date, parseInt(limitDays));

    return format(endDate, 'yyyyMMdd');
  }

  /**
   * 쿠폰(PIN) 발급
   */
  async issue(obj: DaouIssueIn): Promise<DaouIssueOut> {
    try {
      const today = format(new Date(), 'yyyyMMdd');
      const limitEndDate = this.calculateLimitEndDate(today, obj.limitDate);

      // URL 파라미터 구성
      const params = new URLSearchParams({
        COOPER_ID: this.cooperId,
        COOPER_PW: this.cooperPw,
        SITE_ID: this.siteId,
        NO_REQ: obj.goodsId,
        COOPER_ORDER: obj.transactionId,
        ISSUE_COUNT: '1',
        CALL_CTN: obj.phoneNumber,
        RCV_CTN: obj.phoneNumber,
        VALID_START: today,
        VALID_END: limitEndDate,
        PAY_ID: obj.tradeNo,
        BOOKING_NO: obj.tradeNo,
        SITE_URL: 'epopkon.com',
      });

      // URL 구성: baseUrl + ACTION + 파라미터
      const url = `${this.baseUrl}${this.ACTION_ISSUE}&${params.toString()}`;

      this.logger.log(`DAOU Issue URL: ${url}`);

      // TLS 1.2 Agent 사용
      const httpsAgent = this.createHttpsAgent();

      // POST 요청 (실제로는 GET 방식처럼 URL에 파라미터 포함)
      const response = await firstValueFrom(
        this.httpService.post(
          url,
          {},
          {
            httpsAgent,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        ),
      );

      this.logger.log(`DAOU Issue Response: ${response.data}`);

      // XML 응답 파싱
      const xmlResponse = await this.xmlParser.parse(response.data);

      // 성공 응답인지 확인
      if (xmlResponse.RT === 'S000001') {
        return {
          resultCode: xmlResponse.RT,
          resultMessage: xmlResponse.RTMSG || '정상처리',
          pinNo: xmlResponse.NO_CPN,
          tsId: xmlResponse.TS_ID,
        };
      } else {
        return {
          resultCode: xmlResponse.RT || '-1',
          resultMessage: xmlResponse.RTMSG || '쿠폰발행에 실패하였습니다.',
        };
      }
    } catch (error) {
      this.logger.error(`DAOU Issue Error: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException('다우기술 쿠폰 발급 실패');
    }
  }

  /**
   * 쿠폰(PIN) 상태 조회
   */
  async check(obj: DaouCheckIn): Promise<DaouCheckOut> {
    try {
      if (!obj.barCode && !obj.transactionId) {
        throw new Error('DAOU check: barCode 또는 transactionId 중 하나는 필수입니다.');
      }

      // barCode가 있으면 NO_CPN 조회 우선, 없으면 COOPER_ORDER 조회
      const useBarCode = !!obj.barCode;
      const action = useBarCode ? this.ACTION_CHECK_NOCPN : this.ACTION_CHECK;
      const params = new URLSearchParams({
        COOPER_ID: this.cooperId,
        COOPER_PW: this.cooperPw,
        SITE_ID: this.siteId,
        ...(useBarCode ? { NO_CPN: obj.barCode! } : { COOPER_ORDER: obj.transactionId! }),
      });

      // URL 구성: baseUrl + ACTION + 파라미터
      const url = `${this.baseUrl}${action}&${params.toString()}`;

      this.logger.log(`DAOU Check URL: ${url}`);

      // TLS 1.2 Agent 사용
      const httpsAgent = this.createHttpsAgent();

      const response = await firstValueFrom(
        this.httpService.post(
          url,
          {},
          {
            httpsAgent,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        ),
      );

      this.logger.log(`DAOU Check Response: ${response.data}`);

      // XML 응답 파싱
      const xmlResponse = await this.xmlParser.parse(response.data);

      // 응답 처리
      if (xmlResponse.RT === 'S000001') {
        return {
          resultCode: xmlResponse.RT,
          resultMessage: xmlResponse.RTMSG || '정상처리',
          cpnStatus: xmlResponse.CPN_STATUS, // 00: 미사용, 01: 교환완료, 02: 기취소, 03: 사용중
          cpnEnd: xmlResponse.CPN_END,
          useDate: xmlResponse.USE_DATE,
          useBranch: xmlResponse.USE_STORE,
        };
      } else {
        return {
          resultCode: xmlResponse.RT || '-1',
          resultMessage: xmlResponse.RTMSG || '쿠폰 조회 실패',
        };
      }
    } catch (error) {
      this.logger.error(`DAOU Check Error: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException('다우기술 쿠폰 상태 조회 실패');
    }
  }

  /**
   * 쿠폰(PIN) 취소
   */
  async cancel(obj: DaouCancelIn): Promise<DaouCancelOut> {
    try {
      // URL 파라미터 구성
      const params = new URLSearchParams({
        COOPER_ID: this.cooperId,
        COOPER_PW: this.cooperPw,
        NO_CPN: obj.pinNo,
        SITE_ID: this.siteId,
        REQUEST_ID: 'epopkon',
        REASON: 'cancel',
      });

      // URL 구성: baseUrl + ACTION + 파라미터
      const url = `${this.baseUrl}${this.ACTION_CANCEL}&${params.toString()}`;

      this.logger.log(`DAOU Cancel URL: ${url}`);

      // TLS 1.2 Agent 사용
      const httpsAgent = this.createHttpsAgent();

      const response = await firstValueFrom(
        this.httpService.post(
          url,
          {},
          {
            httpsAgent,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        ),
      );

      this.logger.log(`DAOU Cancel Response: ${response.data}`);

      // XML 응답 파싱
      const xmlResponse = await this.xmlParser.parse(response.data);

      // 응답 처리
      if (xmlResponse.RT === 'S000001') {
        return {
          resultCode: xmlResponse.RT,
          resultMessage: xmlResponse.RTMSG || '정상처리',
        };
      }

      // cancel 실패 → check 로 멱등 검증 (cpnStatus=02 = 기취소)
      return await this.verifyCancelIdempotent(
        obj,
        `${xmlResponse.RT || '-1'}: ${xmlResponse.RTMSG || '쿠폰취소에 실패하였습니다.'}`,
      );
    } catch (error) {
      this.logger.error(`DAOU Cancel Error: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
      throw error;
    }
  }

  /**
   * cancel 실패 응답 검증.
   * check 로 cpnStatus 가 '02'(기취소) 인지 확인하여 멱등 처리한다.
   */
  private async verifyCancelIdempotent(obj: DaouCancelIn, reason: string): Promise<DaouCancelOut> {
    this.logger.warn(
      `[cancel] 에러(${reason}) - check 로 멱등 검증. pinNo: ${obj.pinNo}`,
    );
    const checkResult = await this.check({ barCode: obj.pinNo });
    if (checkResult.cpnStatus === '02') {
      this.logger.warn(
        `[cancel] check 결과 cpnStatus=02 (기취소) 확인 - 멱등 처리. pinNo: ${obj.pinNo}`,
      );
      return {
        resultCode: 'S000001',
        resultMessage: '이미 취소된 쿠폰 (멱등 처리)',
      };
    }
    throw new Error(
      `[DAOU] cancel 에러(${reason})이나 check cpnStatus=${checkResult.cpnStatus ?? 'undefined'} - pinNo: ${obj.pinNo}`,
    );
  }

  /**
   * 전체 상품 정보 조회
   * API 스펙에서 HTTP GET 명시 — 기존 issue/check/cancel은 POST
   */
  async goodsInfo(): Promise<DaouGoodsInfoOut> {
    try {
      // URL 파라미터 구성 (인증 정보만 사용)
      const params = new URLSearchParams({
        COOPER_ID: this.cooperId,
        COOPER_PW: this.cooperPw,
        SITE_ID: this.siteId,
      });

      // URL 구성: baseUrl + ACTION + 파라미터
      const url = `${this.baseUrl}${this.ACTION_GOODS_INFO}&${params.toString()}`;

      this.logger.log(`DAOU GoodsInfo URL: ${url}`);

      // TLS 1.2 Agent 사용
      const httpsAgent = this.createHttpsAgent();

      // GET 요청 (API 스펙 명시 — 기존 메서드의 POST와 다름)
      const response = await firstValueFrom(
        this.httpService.get(url, { httpsAgent }),
      );

      this.logger.log(`DAOU GoodsInfo Response: ${response.data}`);

      // XML 응답 파싱 (배열 구조 전용 파서)
      const parsed = await this.xmlParser.parseGoodsInfo(response.data);

      // 성공 응답인지 확인
      if (parsed.rt === 'S000001') {
        // XML 키 → 시맨틱 camelCase 매핑
        const goods: DaouGoodsInfoItem[] = parsed.goodsList.map((item) => ({
          reqNo: item.NO_REQ || '',
          reqName: item.NM_REQ || '',
          goodsNo: item.NO_GOODS || '',
          goodsName: item.NM_GOODS || '',
          goodsCompany: item.GOODS_COMPANY || '',
          goodsCompanyName: item.NM_GOODS_COMPANY || '',
          goodsPrice: item.GOODS_PRICE || '',
          cpnPrice: item.CPN_PRICE || '',
          goodsImage: item.GOODS_IMAGE || '',
          category: item.CATEGORY || '',
          validStart: item.VALID_START || '',
          validEnd: item.VALID_END || '',
          siteId: item.SITE_ID || '',
          goodsCompanyCharge: item.GOODS_COMPANY_CHARGE || '',
          goodsCnt: item.GOODS_CNT || '',
          discountPrice: item.DISCOUNT_PRICE || '',
          goodsDiscount: item.GOODS_DISCOUNT || '',
          isChanged: item.YN_CHANGED || '',
          changedDate: item.CHANGED_DATE || '',
          regDate: item.REG_DATE || '',
        }));

        return {
          resultCode: parsed.rt,
          resultMessage: parsed.rtmsg || '정상처리',
          listCount: parsed.listCount,
          goods,
        };
      } else {
        return {
          resultCode: parsed.rt || '-1',
          resultMessage: parsed.rtmsg || '상품 정보 조회에 실패하였습니다.',
          listCount: 0,
          goods: [],
        };
      }
    } catch (error) {
      this.logger.error(`DAOU GoodsInfo Error: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException('다우기술 상품 정보 조회 실패');
    }
  }
}
