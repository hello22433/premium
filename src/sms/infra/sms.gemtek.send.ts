import { ISmsSend, SmsSendIn, SmsSendOut } from '../interface/sms.send';
import { GemteckMsgQueueEntity } from '../../entity/gemtek/msg.queue.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { InsertResult, Repository } from 'typeorm';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** MSSQL unique index/제약 위반 에러 번호 (2601 = unique index, 2627 = unique constraint) */
const MSSQL_UNIQUE_VIOLATION_NUMBERS = [2601, 2627];

export class SmsGemtekSend implements ISmsSend {
  constructor(
    // private configService: ConfigService,
    @InjectRepository(GemteckMsgQueueEntity, 'gemtek_sms')
    private gemteckMsgQueueRepository: Repository<GemteckMsgQueueEntity>,
    private configService: ConfigService,
  ) {}

  private logger = new Logger('SMS_GEMTEK');

  async send(obj: SmsSendIn): Promise<SmsSendOut> {
    const fileCnt = obj.filePath.length;

    if (fileCnt > 5) {
      throw new Error('There cannot be more than 5');
    }

    const fileLocations = Array(5)
      .fill(null)
      .map((_, index) => obj.filePath[index] ?? null);

    const [fileLoc1, fileLoc2, fileLoc3, fileLoc4, fileLoc5] = fileLocations;

    try {
      const result = await this.gemteckMsgQueueRepository
        .createQueryBuilder('gemteckMsgQueue')
        .insert()
        .into('MSG_QUEUE')
        .values({
          msgType: obj.msgType,
          dstAddr: obj.to,
          callback: obj.from,
          subject: obj.subject,
          text: obj.text,
          fileCnt,
          requestTime: () => 'GETDATE()',
          fileLoc1,
          fileLoc2,
          fileLoc3,
          fileLoc4,
          fileLoc5,
          senderCode: this.configService.get('DATABASE_GEMTEK_SMS_SENDER_CODE'),
          extCol2: obj.attemptId ?? null,
          extCol3: obj.traceRef ?? null,
        })
        .execute();

      return { mseq: this.extractMseq(result), recovered: false };
    } catch (e) {
      return await this.recoverOrRethrow(e, obj.attemptId);
    }
  }

  async smsSend(obj: GemteckMsgQueueEntity): Promise<SmsSendOut> {
    try {
      const result = await this.gemteckMsgQueueRepository
        .createQueryBuilder('gemteckMsgQueue')
        .insert()
        .into('MSG_QUEUE')
        .values({
          msgType: obj.msgType,
          dstAddr: obj.dstAddr,
          callback: obj.callback,
          text: obj.text,
          requestTime: () => 'GETDATE()',
          senderCode: this.configService.get('DATABASE_GEMTEK_SMS_SENDER_CODE'),
          extCol2: obj.extCol2 ?? null,
          extCol3: obj.extCol3 ?? null,
        })
        .execute();

      return { mseq: this.extractMseq(result), recovered: false };
    } catch (e) {
      return await this.recoverOrRethrow(e, obj.extCol2);
    }
  }

  /**
   * 상관키(`EXT_COL2`)로 큐 행을 조회해 `MSEQ` 를 복구한다.
   *
   * 응답 유실·타임아웃 시 수신번호나 시각으로 추정하지 않고 상관키로만 조회한다(§3 다).
   * 정확히 1건일 때만 복구하고, 0건·복수 건이면 `null` 을 반환해 상위가 `UNKNOWN` 으로 처리하게 한다.
   */
  async findMseqByAttemptId(attemptId: string): Promise<number | null> {
    const rows = await this.gemteckMsgQueueRepository
      .createQueryBuilder('gemteckMsgQueue')
      .select('gemteckMsgQueue.mseq', 'mseq')
      .where('gemteckMsgQueue.extCol2 = :attemptId', { attemptId })
      .limit(2)
      .getRawMany<{ mseq: number }>();

    if (rows.length !== 1) {
      return null;
    }

    return Number(rows[0].mseq);
  }

  /**
   * `EXT_COL2` 부분 unique index 위반은 오류가 아니라 "이미 insert 됨"이다.
   * 기존 `MSEQ` 를 복구해 추적을 이어가고(§9 Gemtek DBA 계약), 복구 불가면 원래 오류를 그대로 올린다.
   */
  private async recoverOrRethrow(error: unknown, attemptId?: string | null): Promise<SmsSendOut> {
    if (attemptId && this.isUniqueViolation(error)) {
      const mseq = await this.findMseqByAttemptId(attemptId);
      if (mseq !== null) {
        this.logger.warn(`EXT_COL2 duplicate insert recovered. attemptId=${attemptId} mseq=${mseq}`);
        return { mseq, recovered: true };
      }
    }

    this.logger.error(error);
    throw error;
  }

  private isUniqueViolation(error: unknown): boolean {
    const number =
      (error as { number?: number; driverError?: { number?: number } })?.number ??
      (error as { driverError?: { number?: number } })?.driverError?.number;

    return typeof number === 'number' && MSSQL_UNIQUE_VIOLATION_NUMBERS.includes(number);
  }

  /**
   * insert 응답에서 `MSEQ` 를 추출한다(MSSQL `OUTPUT INSERTED.MSEQ`).
   * 확보 실패는 발송 실패가 아니므로 throw 하지 않고 `null` 로 남겨 재조회 대상이 되게 한다(§5.3 SUBMITTED).
   */
  private extractMseq(result: InsertResult): number | null {
    const identifier = result.identifiers?.[0]?.mseq ?? result.generatedMaps?.[0]?.mseq;
    const raw = Array.isArray(result.raw) ? (result.raw[0]?.MSEQ ?? result.raw[0]?.mseq) : undefined;
    const value = identifier ?? raw;

    return value === undefined || value === null ? null : Number(value);
  }
}
