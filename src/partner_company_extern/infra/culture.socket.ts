import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';

import { ConfigService } from '@nestjs/config';
import { format, subDays } from 'date-fns';
import * as net from 'node:net';
import * as iconv from 'iconv-lite';
import { firstValueFrom } from 'rxjs';
import { XMLParser } from 'fast-xml-parser';
import {
  CultureCancelIn,
  CultureCheckIn,
  CultureCheckOut,
  CultureCheckDailyIn,
  CultureCheckDailyOut,
  CultureIssueIn,
  CultureIssueOut,
  ICulture,
} from '../interface/culture';

@Injectable()
export class CultureSocket implements ICulture {
  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {
    this.socketIP = this.configService.getOrThrow('CULTURE_LAND_SOCKET_IP');
    this.port = this.configService.getOrThrow('CULTURE_LAND_SOCKET_PORT');
    this.environment = this.configService.getOrThrow('ENVIRONMENT');
  }

  private logger = new Logger('CULTURE_LAND');

  private socketIP = '';
  private port = '';
  private environment = '';

  private fillLeft(length: number, str: string, fillZero: boolean): string {
    let padded = str;
    while (Buffer.byteLength(padded, 'utf-8') < length) {
      padded += fillZero ? '0' : ' ';
    }
    return padded;
  }

  private fillRight(length: number, str: string, fillZero: boolean): string {
    let padded = '';
    while (Buffer.byteLength(padded, 'utf-8') + Buffer.byteLength(str, 'utf-8') < length) {
      padded += fillZero ? '0' : ' ';
    }
    return padded + str;
  }

  private async socketSend(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      const SOCKET_TIMEOUT = 60000; // 60초

      client.setTimeout(SOCKET_TIMEOUT);

      client.on('timeout', () => {
        client.destroy();
        reject(new Error(`Socket timeout after ${SOCKET_TIMEOUT}ms`));
      });

      const responseChunks: Buffer[] = [];

      client.connect(+this.port, this.socketIP, () => {
        this.logger.log('Connected to server');
        client.write(message);
      });

      client.on('data', (data: Buffer) => {
        responseChunks.push(data);
      });

      client.on('end', () => {
        const totalBuffer = Buffer.concat(responseChunks);
        const decoded = iconv.decode(totalBuffer, 'euc-kr');
        this.logger.log(`decoded response: ${decoded}`);
        resolve(decoded);
      });

      client.on('error', (err) => {
        this.logger.error('Socket error:', err);
        reject(err);
      });

      client.on('close', () => {
        this.logger.log('Connection closed');
      });
    });
  }

  private socketResponseParsing(responseMessage: string, id: number): CultureIssueOut | CultureCheckOut {
    let positions: number[];

    if (id === 8120) {
      positions = [4, 4, 7, 20, 4, 30, 16, 16, 20, 5, 9, 8, 50, 44, 63];
    } else if (id == 8220) {
      positions = [4, 4, 7, 20, 4, 16, 16, 9, 9, 8, 6, 30, 1, 166];
    } else {
      // 필요에 따라 추가
      throw new Error(`Unknown ID: ${id}`);
    }

    let startPos = 0;
    const responseMap = positions.map((length) => {
      const field = responseMessage.substring(startPos, startPos + length).trim();
      startPos += length;
      return field;
    });

    this.logger.log(`responseMap: ${responseMap}`);

    if (id === 8220) {
      return {
        HeadNo: responseMap[0],
        MessageLength: responseMap[1],
        MemberCode: responseMap[2],
        SubMemberCode: responseMap[3],
        ResultCode: responseMap[4],
        ScrachNo: responseMap[5],
        CertNo: responseMap[6],
        FaceValue: Number(responseMap[7]) || 0,
        Balance: Number(responseMap[8]) || 0,
        CheckDate: responseMap[9],
        CheckTime: responseMap[10],
        ErrMsg: responseMap[11],
        CancelPossibility: responseMap[12] as 'Y' | 'N',
        Filler: responseMap[13],
      };
    }

    return {
      HeadNo: responseMap[0],
      MessageLength: responseMap[1],
      MemberCode: responseMap[2],
      SubMemberCode: responseMap[3],
      ResultCode: responseMap[4],
      MemberControlCode: responseMap[5],
      ScrachNo: responseMessage.slice(69, 85),
      CertNo: responseMap[7],
      ControlCode: responseMap[8],
      CertType: responseMap[9],
      FaceValue: responseMap[10],
      Validity: responseMap[11],
      LinkURL: responseMap[12],
      EncScrachNos: responseMap[13],
      Filler: responseMap[14],
    };
  }

  async issue(obj: CultureIssueIn): Promise<CultureIssueOut> {
    const memberCode =
      obj.expireDay === 60
        ? this.configService.getOrThrow('CULTURE_LAND_SOCKET_MEMBER_CODE_60')
        : this.configService.getOrThrow('CULTURE_LAND_SOCKET_MEMBER_CODE');
    const subMemberCode =
      obj.expireDay === 60
        ? this.configService.getOrThrow('CULTURE_LAND_SOCKET_SUB_MEMBER_CODE_60')
        : this.configService.getOrThrow('CULTURE_LAND_SOCKET_SUB_MEMBER_CODE');

    const sbURLParam: string[] = [];
    sbURLParam.push('8110'); // HeadNo
    sbURLParam.push('0292'); // MessageLength
    sbURLParam.push(this.fillLeft(7, memberCode, false)); // MemberCode
    sbURLParam.push(this.fillLeft(20, subMemberCode, false)); // SubMemberCode
    sbURLParam.push(this.fillLeft(30, obj.transactionId, false)); // MemberControlCode
    sbURLParam.push(this.fillLeft(5, 'AU', false)); // CertType
    sbURLParam.push(this.fillRight(9, '' + obj.price, true)); // RequestAmount
    sbURLParam.push(this.fillLeft(8, format(new Date(), 'yyyyMMdd'), false)); // RequestDate
    sbURLParam.push(this.fillLeft(6, format(new Date(), 'HHmmss'), false)); // RequestTime
    sbURLParam.push(this.fillLeft(2, '00', false)); // SendType
    sbURLParam.push(this.fillLeft(12, '', false)); // SendPhoneNumber
    sbURLParam.push(this.fillRight(9, '' + obj.price, true)); // SalePrice
    sbURLParam.push(this.fillLeft(100, '', false)); // SendMessage
    sbURLParam.push(this.fillLeft(84, '', false)); // Filler
    try {
      const massage = sbURLParam.join('');
      const response = await this.socketSend(massage);

      if (!response) {
        throw new Error('not exist response');
      }
      this.logger.log(`response : ${response}`);
      const issueOut = this.socketResponseParsing(response, 8120);
      this.logger.log(`issueOut : ${JSON.stringify(issueOut)}`);
      return issueOut as CultureIssueOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  // 상품코드상품권 종류 CertType
  // AU : 통합 모바일문화상품권 (컬쳐캐시 충전가능)
  // OU : 통합 모바일문화상품권 (오프라인 전용, 컬쳐캐시 충전불가)
  // FM : CU 모바일문화상품권
  // GS : GS25 모바일문화상품권
  // 7E : 코리아7 모바일문화상품권 (세븐일레븐, 바이더웨이)
  // MN : 미니스톱 모바일문화상품권
  // CGV : CGV 모바일문화상품권
  // EMART : 이마트24 모바일문화상품권

  async cancel(obj: CultureCancelIn): Promise<void> {
    const memberCode =
      obj.expireDay === 60
        ? this.configService.getOrThrow('CULTURE_LAND_SOCKET_MEMBER_CODE_60')
        : this.configService.getOrThrow('CULTURE_LAND_SOCKET_MEMBER_CODE');
    const subMemberCode =
      obj.expireDay === 60
        ? this.configService.getOrThrow('CULTURE_LAND_SOCKET_SUB_MEMBER_CODE_60')
        : this.configService.getOrThrow('CULTURE_LAND_SOCKET_SUB_MEMBER_CODE');

    const sbURLParam: string[] = [];
    sbURLParam.push('8310'); // HeadNo
    sbURLParam.push('0292'); // MessageLength
    sbURLParam.push(this.fillLeft(7, memberCode, false)); // MemberCode
    sbURLParam.push(this.fillLeft(20, subMemberCode, false)); // SubMemberCode
    sbURLParam.push(this.fillLeft(16, obj.barCode, false)); // ScratchNo
    sbURLParam.push(this.fillLeft(8, format(new Date(), 'yyyyMMdd'), false)); // CancelDate
    sbURLParam.push(this.fillLeft(6, format(new Date(), 'HHmmss'), false)); // CancelTime
    sbURLParam.push(this.fillLeft(2, '10', false)); // CancelType
    sbURLParam.push(this.fillLeft(233, '', false)); // Filler

    try {
      const massage = sbURLParam.join('');
      const response = await this.socketSend(massage);

      if (!response) {
        throw new Error('not exist response');
      }
      this.logger.log(`response : ${response}`);
      this.logger.log(`response : ${JSON.stringify(response)}`);

      // 응답 레이아웃: HeadNo(0-3) + MessageLength(4-7) + MemberCode(8-14)
      // + SubMemberCode(15-34) + ResultCode(35-38) + ScrachNo(39-54) + ErrMsg(55-84)
      const resultCode = response.substring(35, 39);
      const errMsg = response.substring(55, 85).trim();
      if (resultCode !== '0000') {
        throw new Error(`CULTURELAND cancel 실패: ${resultCode} - ${errMsg}`);
      }
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  async check(obj: CultureCheckIn): Promise<CultureCheckOut> {
    const requestAt = obj.requestAt ?? new Date();

    const memberCode =
      obj.expireDay === 60
        ? this.configService.getOrThrow('CULTURE_LAND_SOCKET_MEMBER_CODE_60')
        : this.configService.getOrThrow('CULTURE_LAND_SOCKET_MEMBER_CODE');

    const subMemberCode =
      obj.expireDay === 60
        ? this.configService.getOrThrow('CULTURE_LAND_SOCKET_SUB_MEMBER_CODE_60')
        : this.configService.getOrThrow('CULTURE_LAND_SOCKET_SUB_MEMBER_CODE');

    // 메시지 구성 (총 300 Bytes)
    const sbURLParam: string[] = [];
    sbURLParam.push('8210'); // HeadNo
    sbURLParam.push('0292'); // MessageLength
    sbURLParam.push(this.fillLeft(7, memberCode, false)); // MemberCode
    sbURLParam.push(this.fillLeft(20, subMemberCode, false)); // SubMemberCode
    sbURLParam.push(this.fillLeft(16, obj.scrachNo, false)); // ScrachNo
    sbURLParam.push(this.fillLeft(16, obj.certNo, false)); // CertNo
    sbURLParam.push(this.fillLeft(8, format(requestAt, 'yyyyMMdd'), false)); // RequestDate
    sbURLParam.push(this.fillLeft(6, format(requestAt, 'HHmmss'), false)); // RequestTime
    sbURLParam.push(this.fillLeft(219, '', false)); // Filler

    try {
      const message = sbURLParam.join('');
      const response = await this.socketSend(message);

      if (!response) {
        throw new Error('not exist response');
      }

      this.logger.log(`response : ${response}`);
      const parsed = this.socketResponseParsing(response, 8220);
      this.logger.log(`check : ${JSON.stringify(parsed)}`);

      return parsed as CultureCheckOut;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  /**
   * 일대사(Daily Batch) - 60일 상품 전용
   * 전날 사용된 상품권 목록 조회 (HTTP API)
   * 참고: 컬쳐랜드상품권(모바일문화상품권)_사용PIN확인_연동가이드_V2.1.pdf
   */
  async checkDaily(obj: CultureCheckDailyIn): Promise<CultureCheckDailyOut> {
    // 사용일 기본값: 어제
    const useDate = obj.useDate ?? format(subDays(new Date(), 1), 'yyyyMMdd');

    // 60일 상품 계정만 사용
    const memberCode = this.configService.getOrThrow('CULTURE_LAND_SOCKET_MEMBER_CODE_60');
    const subMemberCode = this.configService.getOrThrow('CULTURE_LAND_SOCKET_SUB_MEMBER_CODE_60');

    // URL 결정 (환경별)
    const url =
      this.environment === 'prod'
        ? 'https://manager.cultureland.co.kr/giftcard/usePinDayRequest_kcpi.asp'
        : 'https://tsalecheck.cultureland.co.kr/giftcard/usePinDayRequest_kcpi.asp';

    this.logger.log(`[checkDaily] URL: ${url}, UseDate: ${useDate}`);

    try {
      // HTTP 요청 (POST)
      const response = await firstValueFrom(
        this.httpService.post(
          url,
          `MemberCode=${memberCode}&SubMemberCode=${subMemberCode}&UseDate=${useDate}`,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            responseType: 'arraybuffer', // euc-kr 인코딩 처리를 위해
          },
        ),
      );

      // euc-kr 디코딩
      const decodedResponse = iconv.decode(Buffer.from(response.data), 'euc-kr');
      this.logger.log(`[checkDaily] Response: ${decodedResponse}`);

      // XML 파싱
      const parser = new XMLParser();
      const xmlData = parser.parse(decodedResponse);

      // certno 목록 추출
      let certNoList: string[] = [];
      if (xmlData.response?.result?.certno) {
        const certno = xmlData.response.result.certno;
        certNoList = Array.isArray(certno) ? certno : [certno];
      }

      return {
        memberCode: xmlData.response?.membercode || memberCode,
        subMemberCode: xmlData.response?.submembercode || subMemberCode,
        useDate: xmlData.response?.usedate || useDate,
        certNoList,
      };
    } catch (e) {
      this.logger.error(`[checkDaily] Error: ${e}`);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }
}
