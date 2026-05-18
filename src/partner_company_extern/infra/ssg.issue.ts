import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import { firstValueFrom } from 'rxjs';
import * as iconv from 'iconv-lite';
import { Parser } from 'xml2js';
import { ISsgCheckIn, ISsgCheckOut, ISsgIssue, ISsgIssueCode, ISsgIssueIn, ISsgIssueOut } from '../interface/ssg.issue';

/**
 * SSG 조회 API가 정상 응답했지만 PIN이 미등록(code ≠ 1001)인 경우 전용 에러
 * 네트워크 에러, 타임아웃 등 API 호출 자체 실패와 구분하기 위해 사용
 */
export class SsgCheckNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SsgCheckNotFoundError';
  }
}

/**
 * SSG issue API가 정상 응답을 돌려줬지만 코드가 1000이 아닌 경우 (신세계 측 거절 확정).
 * plans/ssg-balance-refactor.md PR1 — typed error 정의(PR2에서 issue()가 throw 적용).
 *
 * 이 에러는 "INSERT 결과 = 실패 확정" 시그널이다. 호출자는 SsgInsertState.FAILED로 마킹하고
 * SSG 행사 잔액 복구 분기로 진입해도 된다.
 */
export class SsgIssueRejectedError extends Error {
  constructor(public readonly code: string | null, reason: string) {
    super(reason);
    this.name = 'SsgIssueRejectedError';
  }
}

/**
 * SSG issue API 호출 자체가 실패한 경우 (네트워크 오류, timeout, parsing 실패 등).
 * plans/ssg-balance-refactor.md PR1 — typed error 정의(PR2에서 throw wrap 적용).
 *
 * 이 에러는 "INSERT 결과 = 미확정" 시그널이다. 호출자는 SsgInsertState.ATTEMPTED를 유지하고
 * orphan resolver가 SSG check로 실제 등록 여부를 확정한 뒤 분기해야 한다.
 */
export class SsgIssueUnknownError extends Error {
  constructor(reason: string, public readonly cause?: unknown) {
    super(reason);
    this.name = 'SsgIssueUnknownError';
  }
}

@Injectable()
export class SsgIssue implements ISsgIssue {
  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    const ssgApiUrl = this.configService.get<string>('SSG_API_URL');
    if (ssgApiUrl) {
      this.url = ssgApiUrl;
    } else if (this.configService.getOrThrow('ENVIRONMENT') === 'prod') {
      this.url = 'https://api.epopkon.com';
    }
  }

  private readonly logger = new Logger('SSG');

  private url = 'https://tapi.epopkon.com';

  private readonly parser = new Parser();

  generateSsgIssue(): ISsgIssueCode {
    const barCode = this.generateCode('8', 7);
    const personalCode = this.generateCode('013', 8);

    return { barCode, personalCode };
  }

  async issue(obj: ISsgIssueIn): Promise<ISsgIssueOut> {
    const data = new URLSearchParams({
      event_no: obj.eventNo,
      event_seq: String(obj.eventSeq),
      event_key: obj.eventKey,
      vno: obj.vno,
      pin_no: obj.pinNo,
      user_name: obj.userName,
      user_amount: obj.userAmount,
      msg_content: obj.msgContent,
      tr_id: obj.trId,
      call_back: obj.callBack,
    });

    const sendUrl = `${this.url}/SsgCoupon.do?${data.toString()}`;
    this.logger.log(sendUrl);

    const response = await firstValueFrom(this.httpService.get(sendUrl));
    this.logger.log(response.data);

    const resultToJson = (await this.parser.parseStringPromise(response.data)) as unknown as ISsgIssueOut;
    this.logger.log(resultToJson);

    const code = resultToJson?.response?.result?.[0]?.code?.[0];
    const reason = resultToJson?.response?.result?.[0]?.reason?.[0];
    if (code !== '1000') {
      throw new Error(reason ?? `SSG 등록 실패 (code: ${code ?? 'null'})`);
    }
    return resultToJson;
  }

  private generateCode(prefix: string, length: number): string {
    const max = Math.pow(10, length);
    const randomNumber = randomInt(max);
    return prefix + randomNumber.toString().padStart(length, '0');
  }

  // EUC-KR이 Latin-1로 잘못 해석된 문자열 복원
  private fixMojibake(str: string): string {
    try {
      const bytes = Buffer.from(str, 'latin1');
      return iconv.decode(bytes, 'euc-kr');
    } catch {
      return str;
    }
  }

  async check(obj: ISsgCheckIn): Promise<ISsgCheckOut> {
    const data = new URLSearchParams({
      event_no: obj.eventNo,
      event_seq: String(obj.eventSeq),
      vno: obj.vno,
    });

    const sendUrl = `${this.url}/GetSsgStatus.do?${data.toString()}`;
    this.logger.log(sendUrl);

    const response = await firstValueFrom(this.httpService.get(sendUrl));
    this.logger.log(response.data);

    const resultToJson = (await this.parser.parseStringPromise(response.data)) as unknown as ISsgCheckOut;

    // value.result 필드 인코딩 복원 (EUC-KR → UTF-8)
    if (resultToJson.response.value?.[0]?.result?.[0]) {
      resultToJson.response.value[0].result[0] = this.fixMojibake(resultToJson.response.value[0].result[0]);
    }

    this.logger.log(resultToJson);

    const code = resultToJson?.response?.result?.[0]?.code?.[0];
    const reason = resultToJson?.response?.result?.[0]?.reason?.[0];
    if (code !== '1001') {
      throw new SsgCheckNotFoundError(reason ?? `SSG 조회 실패 (code: ${code ?? 'null'})`);
    }
    return resultToJson;
  }
}
