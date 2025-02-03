import { Injectable, Logger } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { ConfigService } from '@nestjs/config';
import { format } from 'date-fns';
import * as net from 'node:net';
import { CultureIssueIn, CultureIssueOut, ICulture } from '../interface/culture';

@Injectable()
export class CultureSocket implements ICulture {
  constructor(private configService: ConfigService) {
    this.socketIP = this.configService.getOrThrow('CULTURE_LAND_SOCKET_IP');
    this.port = this.configService.getOrThrow('CULTURE_LAND_SOCKET_PORT');
  }
  private socket: Socket;
  private logger = new Logger('CULTURE_LAND');

  private socketIP = '';
  private port = '';

  // 모듈 초기화 시 연결 설정
  onModuleInit() {
    this.socket = io(`http://${this.socketIP}:${this.socket}`, {
      transports: ['websocket'], // WebSocket만 사용할 경우 명시적으로 설정
      query: {
        // token: 'your_auth_token', // 인증 토큰 또는 필요한 쿼리 추가
      },
    });

    this.configureSocketListeners();
  }

  // 소켓 연결 해제
  onModuleDestroy() {
    this.socket.disconnect();
  }

  // 이벤트 리스너 설정
  private configureSocketListeners() {
    this.socket.on('connect', () => {
      this.logger.log('Connected to external socket server');
    });

    this.socket.on('disconnect', () => {
      this.logger.log('Disconnected from external socket server');
    });

    this.socket.on('someEvent', (data) => {
      this.logger.log('Data received from external server:', data);
    });
  }

  // 메시지 보내기
  // sendMessage(event: string, data: any) {
  //   this.socket.emit(event, data);
  // }

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

  private async socketSend(massage: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      const responseChunks: string[] = [];

      client.connect(+this.port, this.socketIP, () => {
        console.log('Connected to server');
        client.write(massage);
      });

      client.on('data', (data) => {
        responseChunks.push(data.toString());
      });

      client.on('end', () => {
        resolve(responseChunks.join(''));
      });

      client.on('error', (err) => {
        console.error('Socket error:', err);
        reject(err);
      });

      client.on('close', () => {
        console.log('Connection closed');
      });
    });
  }

  private socketResponseParsing(responseMessage: string, id: number): CultureIssueOut {
    let positions: number[];

    if (id === 8120) {
      positions = [4, 4, 7, 20, 4, 30, 16, 16, 20, 5, 9, 8, 50, 44, 63];
    } else {
      // 필요에 따라 추가
      throw new Error(`Unknown ID: ${id}`);
    }

    let startPos = 0;
    const responseMap = positions.map((length) => {
      const field = responseMessage.substring(startPos, length).trim();
      startPos += length;
      return field;
    });

    return {
      HeadNo: responseMap[0],
      MessageLength: responseMap[1],
      MemberCode: responseMap[2],
      SubMemberCode: responseMap[3],
      ResultCode: responseMap[4],
      MemberControlCode: responseMap[5],
      ScrachNo: responseMap[6],
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
      const issueOut = this.socketResponseParsing(response, 8120);
      return issueOut;
    } catch (e) {
      this.logger.error(e);
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
}
