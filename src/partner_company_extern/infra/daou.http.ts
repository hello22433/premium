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
  private readonly ACTION_ISSUE = 'CI102_ISSUECPN_WITHPAY'; // 쿠폰 발급
  private readonly ACTION_CANCEL = 'CI104_DISUSECPN'; // 쿠폰 취소
  private readonly ACTION_CHECK = 'CI07113_QUERY_COOPERORDER_WITHPAY'; // 쿠폰 상태 조회

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
      // URL 파라미터 구성
      const params = new URLSearchParams({
        COOPER_ID: this.cooperId,
        COOPER_PW: this.cooperPw,
        SITE_ID: this.siteId,
        COOPER_ORDER: obj.transactionId,
      });

      // URL 구성: baseUrl + ACTION + 파라미터
      const url = `${this.baseUrl}${this.ACTION_CHECK}&${params.toString()}`;

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
          cpnStatus: xmlResponse.CPN_STATUS, // 00: 미사용, 01: 교환완료, 02: 기취소
          useDate: xmlResponse.USE_DATE,
          useBranch: xmlResponse.USER_STORE,
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
      } else {
        return {
          resultCode: xmlResponse.RT || '-1',
          resultMessage: xmlResponse.RTMSG || '쿠폰취소에 실패하였습니다.',
        };
      }
    } catch (error) {
      this.logger.error(`DAOU Cancel Error: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException('다우기술 쿠폰 취소 실패');
    }
  }
}
