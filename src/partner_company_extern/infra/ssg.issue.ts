import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import { firstValueFrom } from 'rxjs';
import * as iconv from 'iconv-lite';
import { Parser } from 'xml2js';
import {
  ISsgAmountIn,
  ISsgAmountOut,
  ISsgAmountResult,
  ISsgCheckIn,
  ISsgCheckOut,
  ISsgIssue,
  ISsgIssueCode,
  ISsgIssueIn,
  ISsgIssueOut,
  ISsgTryIn,
  ISsgTryOut,
} from '../interface/ssg.issue';

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
  constructor(
    public readonly code: string | null,
    reason: string,
  ) {
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
  constructor(
    reason: string,
    public readonly cause?: unknown,
  ) {
    super(reason);
    this.name = 'SsgIssueUnknownError';
  }
}

/**
 * SSG INSERT 시도 중복 — 이미 ATTEMPTED state row 존재.
 * plans/ssg-balance-refactor.md PR2.
 *
 * markAttempted()가 SKIPPED_ACTIVE 를 반환했을 때 caller가 외부 INSERT 호출을 막기 위해 throw.
 * 실패 확정이 아니라 "미확정 시도가 진행 중"이므로 markFailed() 대상 아님.
 * orphan resolver가 SSG check로 실제 등록 여부를 확정해야 한다.
 */
export class SsgIssueAttemptAlreadyActiveError extends Error {
  constructor(public readonly orderDeliveryId: number) {
    super(`SSG INSERT 시도가 이미 진행 중 (ATTEMPTED). orderDeliveryId=${orderDeliveryId}`);
    this.name = 'SsgIssueAttemptAlreadyActiveError';
  }
}

/**
 * SSG INSERT 시도 invariant violation — 이미 CONFIRMED state 인데 새 INSERT 시도.
 * plans/ssg-balance-refactor.md PR2.
 *
 * 정상 경로라면 기존 PIN 확인 단계(`needsInsert=false`)에서 걸렸어야 한다.
 * markAttempted()가 SKIPPED_TERMINAL 을 반환하면 호출자는 이 에러로 중단해 운영 알림을 유도한다.
 * markFailed() 대상 아님 (이미 성공한 상태를 망가뜨리지 않음).
 */
export class SsgIssueAlreadyConfirmedError extends Error {
  constructor(public readonly orderDeliveryId: number) {
    super(`SSG INSERT 가 이미 CONFIRMED 상태인데 새 시도 호출됨. orderDeliveryId=${orderDeliveryId}`);
    this.name = 'SsgIssueAlreadyConfirmedError';
  }
}

/**
 * ssg_issue_log 의 PIN 후보 유일성 제약 위반 — 이 후보는 이미 다른 발송 건이 선점했다.
 * docs/plans/2026-08-04-ssg-issue-log-unique-typed-collision.md
 *
 * `uq_ssg_issue_log_bar_code` / `uq_ssg_issue_log_personal_code` 위반만 이 에러로 승격된다.
 * 그 외 unique 충돌과 DB 오류는 원본 그대로 전파한다 (오분류 시 남의 PIN 을 이 발송 건에 부착할 위험).
 *
 * 발생 시점은 SSG INSERT **이전**(markAttempted 구간)이므로 벤더 HTTP 호출은 0 이다.
 * 호출자(PartnerCompanyExternService.issue)는 이 에러를 받아 다음 PIN 후보로 진행한다.
 */
export class SsgIssueLogKeyCollisionError extends Error {
  constructor(
    public readonly orderDeliveryId: number,
    public readonly collidedKey: 'bar_code' | 'personal_code',
    public readonly cause?: unknown,
  ) {
    super(`ssg_issue_log ${collidedKey} 후보 충돌. orderDeliveryId=${orderDeliveryId}`);
    this.name = 'SsgIssueLogKeyCollisionError';
  }
}

/**
 * GetSsgTry.do(cust_info 시도내역 조회) 호출 자체 실패 (검증 거절, 네트워크/파싱 오류 등).
 * "제출 여부 미확정" 시그널 — 호출자는 보수적으로 보류(새 INSERT/재사용 모두 금지)해야 한다.
 */
export class SsgTryError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SsgTryError';
  }
}

/**
 * SSG 가 cust_info 를 아직 cust_info_result 로 옮기지 않음 = 처리중.
 * (GetSsgTry tryYn=Y 인데 GetSsgStatus 가 결과 없음(8021))
 * 재발송 보류 후 사용자에게 "잠시 후 재시도" 안내. markFailed 대상 아님.
 */
export class SsgProcessingError extends Error {
  constructor(public readonly orderDeliveryId?: number) {
    super(`SSG 가 해당 핀번호를 처리중 (cust_info_result 미반영). orderDeliveryId=${orderDeliveryId ?? '?'}`);
    this.name = 'SsgProcessingError';
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
    if (code == null) {
      // 응답 schema가 망가져 code 자체를 못 읽음 (malformed XML, 부분 응답, 예상 밖 구조 등).
      // INSERT 결과 자체가 미확정이므로 거절 확정으로 처리해서는 안 된다 (FAILED 마킹 금지).
      // ATTEMPTED 유지 → orphan resolver가 SSG check로 확정해야 한다.
      throw new SsgIssueUnknownError(reason ?? 'SSG 등록 응답에서 code를 파싱하지 못했습니다 (응답 schema 비정상).');
    }
    if (code !== '1000') {
      // 정상 응답이지만 신세계 측 거절 확정.
      // 호출자는 이 에러를 catch해 SsgInsertState.FAILED로 마킹하고 SSG 행사 잔액 복구 분기를 탈 수 있다.
      throw new SsgIssueRejectedError(code, reason ?? `SSG 등록 실패 (code: ${code})`);
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

  /**
   * GetSsgTry.do — cust_info(제출 테이블) 시도내역 조회. personalCode(vno) 단독으로
   * "이 번호로 제출한 적 있나"를 확인한다 (전 행사 합산, 중복번호 검사 겸용).
   *
   * 성공 시에만 value.tryYn 이 채워진다. 검증 거절/오류 시 value 가 없으므로 SsgTryError 로 throw.
   * (성공 코드 상수는 SSG 측 구현에 의존하므로 tryYn 존재 여부로 성공/실패를 판정한다)
   */
  async getTry(obj: ISsgTryIn): Promise<ISsgTryOut> {
    const data = new URLSearchParams({
      vno: obj.vno,
    });

    const sendUrl = `${this.url}/GetSsgTry.do?${data.toString()}`;
    this.logger.log(sendUrl);

    let resultToJson: ISsgTryOut;
    try {
      const response = await firstValueFrom(this.httpService.get(sendUrl));
      this.logger.log(response.data);

      resultToJson = (await this.parser.parseStringPromise(response.data)) as unknown as ISsgTryOut;
      this.logger.log(resultToJson);
    } catch (e) {
      // 네트워크·파싱 실패도 "제출 여부 미확정" 이라는 점에서 응답 이상(tryYn 없음)과 같은 의미다.
      // 종전에는 raw 에러가 그대로 새어나가 호출자가 조회 실패를 한 타입으로 다룰 수 없었다.
      // 발송 배치의 2-pass 보류 판정(§10 구현명세)이 이 타입 하나만 보면 되도록 통일한다.
      throw new SsgTryError(`SSG 시도내역 조회 호출 실패: ${e instanceof Error ? e.message : String(e)}`);
    }

    const tryYn = resultToJson?.response?.value?.[0]?.tryYn?.[0];
    if (tryYn !== 'Y' && tryYn !== 'N') {
      const code = resultToJson?.response?.result?.[0]?.code?.[0];
      const reason = resultToJson?.response?.result?.[0]?.reason?.[0];
      throw new SsgTryError(reason ?? `SSG 시도내역 조회 실패 (code: ${code ?? 'null'})`);
    }
    return resultToJson;
  }

  /**
   * GetSsgAmount.do — 행사 단위 주문시도/발급성공/발급실패 금액 집계 조회.
   *
   * check()와 동일 패턴(성공코드 1001)이나 응답은 전부 숫자라 인코딩 복원(fixMojibake) 불필요.
   * 주문이 0건인 행사는 서버가 code=8021(데이터 없음)을 반환하므로 에러가 아닌 0집계로 정규화한다.
   * 그 외 1001이 아닌 코드만 실패로 throw 한다.
   */
  async getAmount(obj: ISsgAmountIn): Promise<ISsgAmountResult> {
    const data = new URLSearchParams({
      event_no: obj.eventNo,
      event_seq: String(obj.eventSeq),
    });

    const sendUrl = `${this.url}/GetSsgAmount.do?${data.toString()}`;
    this.logger.log(sendUrl);

    const response = await firstValueFrom(this.httpService.get(sendUrl));
    this.logger.log(response.data);

    const resultToJson = (await this.parser.parseStringPromise(response.data)) as unknown as ISsgAmountOut;
    this.logger.log(resultToJson);

    const result = resultToJson?.response?.result?.[0];
    const code = result?.code?.[0];
    const reason = result?.reason?.[0];

    // 해당 행사에 주문이 0건이면 서버가 8021(데이터 없음) 반환 → 0집계 정상 처리
    if (code === '8021') {
      return { tryAmt: 0, successAmt: 0, failAmt: 0, pendingAmt: 0 };
    }
    if (code !== '1001') {
      throw new Error(reason ?? `SSG 금액 집계 조회 실패 (code: ${code ?? 'null'})`);
    }

    const value = resultToJson.response.value?.[0];
    const tryAmt = Number(value?.tryAmt?.[0] ?? 0) || 0;
    const successAmt = Number(value?.successAmt?.[0] ?? 0) || 0;
    const failAmt = Number(value?.failAmt?.[0] ?? 0) || 0;

    return {
      tryAmt,
      successAmt,
      failAmt,
      pendingAmt: tryAmt - successAmt - failAmt,
    };
  }
}
