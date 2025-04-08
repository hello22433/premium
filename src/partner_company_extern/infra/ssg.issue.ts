import { ISsgCheckIn, ISsgCheckOut, ISsgIssue, ISsgIssueCode, ISsgIssueIn, ISsgIssueOut } from '../interface/ssg.issue';
import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Parser } from 'xml2js';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class SsgIssue implements ISsgIssue {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    if (this.configService.getOrThrow('ENVIRONMENT') === 'prod') {
      this.url = 'https://api.epopkon.com';
    }
  }

  private logger = new Logger('SSG');

  // private url = 'https://tapi.epopkon.com/'; // test URL
  private url = 'https://api.epopkon.com';

  private parser() {
    return new Parser();
  }

  generateSsgIssue(): ISsgIssueCode {
    const barCode = this.generateCode('8', 7);
    const personalCode = this.generateCode('013', 8);

    return { barCode: barCode, personalCode: personalCode };
  }

  async issue(obj: ISsgIssueIn): Promise<any> {
    const data = new URLSearchParams({
      event_no: obj.eventNo,
      event_key: obj.eventKey,
      vno: obj.vno,
      pin_no: obj.pinNo,
      user_name: obj.userName,
      user_amount: obj.userAmount,
      msg_content: obj.msgContent,
      tr_id: obj.trId,
      call_back: obj.callBack,
    });

    try {
      const sendUrl = `${this.url}/SsgCoupon.do?${data.toString()}&event_seq=${obj.eventSeq}`;
      this.logger.log(`${sendUrl}`);

      const response = await firstValueFrom(this.httpService.get(`${sendUrl}`));

      this.logger.log(response.data);

      const resultToJson = (await this.parser().parseStringPromise(response.data)) as unknown as ISsgIssueOut;
      this.logger.log(resultToJson);
      if (resultToJson.response.result[0].code[0] !== '1000') {
        throw new Error(`${resultToJson.response.result[0].reason[0]}`);
      }
      return resultToJson;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }

  private generateCode(prefix: string, length: number): string {
    // 난수를 length 자릿수로 제한
    const max = Math.pow(10, length); // 최대 값 (10^length)
    const randomNumber = Math.floor(Math.random() * max); // 0부터 max-1 사이의 랜덤 숫자 생성

    // 자릿수 보장 (부족한 경우 앞에 '0' 추가)
    const paddedNumber = randomNumber.toString().padStart(length, '0');

    // 접두사와 결합한 결과 반환
    return prefix + paddedNumber;
  }

  async check(obj: ISsgCheckIn): Promise<ISsgCheckOut> {
    const data = new URLSearchParams({
      event_no: obj.eventNo,
      vno: obj.vno,
    });
    this.logger.log(data);

    try {
      const sendUrl = `${this.url}/GetSsgStatus.do?${data.toString()}&event_seq=${obj.eventSeq}`;
      this.logger.log(`${sendUrl}`);

      const response = await firstValueFrom(this.httpService.get(`${sendUrl}`));

      this.logger.log(response.data);

      const resultToJson = (await this.parser().parseStringPromise(response.data)) as unknown as ISsgCheckOut;
      this.logger.log(resultToJson);
      if (resultToJson.response.result[0].code[0] !== '1000') {
        throw new Error(`${resultToJson.response.result[0].reason[0]}`);
      }
      return resultToJson;
    } catch (e) {
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
      throw e;
    }
  }
}
