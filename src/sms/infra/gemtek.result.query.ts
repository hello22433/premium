import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isYearMonth } from '../../delivery/domain/result.partition.cursor';

export interface GemtekResultRecord {
  mseq: number;
  stat: string | null;
  result: string | null;
  sendTime: Date | null;
  reportTime: Date | null;
  extCol2: string | null;
}

/**
 * Gemtek 결과 아카이브(`MSG_RESULT_yyyyMM`) 조회.
 *
 * 결과 테이블은 Agent 가 **월별로 자동 생성**하므로 테이블명이 동적이다. 월 문자열은
 * `yyyyMM` 정규식을 통과한 값만 쓰고(주입 차단), 존재하지 않는 월은 오류가 아니라 skip 이다(§7.3).
 * `MSEQ` 는 `MSG_QUEUE` ↔ `MSG_RESULT_yyyyMM` 동일 identity 로 보존 이관되므로 조회 키로 쓴다(§9 실측).
 */
@Injectable()
export class GemtekResultQuery {
  private readonly logger = new Logger(GemtekResultQuery.name);

  /** 존재 확인 결과 캐시(월 단위). 한 번 존재가 확인된 월은 사라지지 않는다. */
  private readonly existingMonths = new Set<string>();

  constructor(
    @InjectDataSource('gemtek_sms')
    private readonly dataSource: DataSource,
  ) {}

  private tableName(month: string): string {
    if (!isYearMonth(month)) {
      throw new Error(`잘못된 결과 테이블 월 형식: ${month}`);
    }
    return `MSG_RESULT_${month}`;
  }

  /** 해당 월 결과 테이블 존재 여부. 미생성 월(발송 0건 등)은 조회 대상에서 제외한다. */
  async resultTableExists(month: string): Promise<boolean> {
    if (this.existingMonths.has(month)) {
      return true;
    }

    const table = this.tableName(month);
    const rows: { cnt: number }[] = await this.dataSource.query(
      `SELECT COUNT(*) AS cnt FROM sys.objects WHERE object_id = OBJECT_ID(@0) AND type = 'U'`,
      [table],
    );

    const exists = Number(rows?.[0]?.cnt ?? 0) > 0;
    if (exists) {
      this.existingMonths.add(month);
    }
    return exists;
  }

  /**
   * `MSEQ` 로 확정 결과를 조회한다. 없으면 null(= 아직 그 월로 이관되지 않음).
   */
  async findByMseq(month: string, mseq: string | number): Promise<GemtekResultRecord | null> {
    if (!(await this.resultTableExists(month))) {
      return null;
    }

    const rows = await this.dataSource.query(
      `SELECT TOP 1 MSEQ, STAT, RESULT, SEND_TIME, REPORT_TIME, EXT_COL2
         FROM ${this.tableName(month)} WHERE MSEQ = @0`,
      [Number(mseq)],
    );

    return this.toRecord(rows?.[0]);
  }

  /**
   * 상관키(`EXT_COL2`)로 결과를 재조회한다(응답 유실·fencing 불일치 복구용, §3 다).
   * 수신번호·시간으로 추정하지 않으며, **정확히 1건일 때만** 복구에 쓴다. 복수면 `null` 을 돌려주고
   * 호출자가 `UNKNOWN` 으로 남긴다.
   */
  async findByAttemptId(month: string, attemptId: string): Promise<GemtekResultRecord | null> {
    if (!(await this.resultTableExists(month))) {
      return null;
    }

    const rows = await this.dataSource.query(
      `SELECT TOP 2 MSEQ, STAT, RESULT, SEND_TIME, REPORT_TIME, EXT_COL2
         FROM ${this.tableName(month)} WHERE EXT_COL2 = @0`,
      [attemptId],
    );

    if (!rows || rows.length !== 1) {
      if (rows && rows.length > 1) {
        this.logger.warn(`상관키 복수 매칭 — 복구하지 않는다. month=${month}, attemptId=${attemptId}`);
      }
      return null;
    }

    return this.toRecord(rows[0]);
  }

  private toRecord(row: Record<string, unknown> | undefined): GemtekResultRecord | null {
    if (!row) {
      return null;
    }

    return {
      mseq: Number(row.MSEQ),
      stat: (row.STAT as string | null) ?? null,
      result: (row.RESULT as string | null) ?? null,
      sendTime: (row.SEND_TIME as Date | null) ?? null,
      reportTime: (row.REPORT_TIME as Date | null) ?? null,
      extCol2: (row.EXT_COL2 as string | null) ?? null,
    };
  }
}
