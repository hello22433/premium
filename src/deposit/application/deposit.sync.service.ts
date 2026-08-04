import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { format, subDays } from 'date-fns';
import { BankDepositEntity } from '../../entity/bank.deposit.entity';
import { DepositSourceHttp } from '../infra/deposit.source.http';
import { DepositSourceItem, DepositSourcePermanentError } from '../interface/deposit.source';

/** 한 요청에 받아올 건수. 계약상 상한 1000. */
const DEFAULT_PAGE_SIZE = 500;
/** 매 주기 다시 받아올 최근 구간(일). 회계전표가 뒤늦게 반영되는 경우까지 덮는다. */
const DEFAULT_RESYNC_DAYS = 30;
/** 미러가 비어 있을 때 백필 시작일. 실데이터는 2025-06 부터라 그보다 앞이면 충분하다. */
const DEFAULT_BACKFILL_FROM = '2020-01-01';
/** 무한 페이지 순회 방지. 500 * 200 = 10만 건이면 백필로도 충분히 크다. */
const MAX_PAGES = 200;

const DATE_FORMAT = 'yyyy-MM-dd';

/**
 * erp_macro 조회 API → 프리미엄 미러 동기화.
 *
 * 설계 요지 (docs/API계약-erp_macro-입금내역-조회.md)
 *  · 증분(updatedSince)이 아니라 **최근 N일을 매번 통째로 다시 받는다.** dedup_key 멱등
 *    upsert 가 있으므로 중복 수신은 비용이 아니라 빠짐을 메우는 안전장치다. 경계 시각·시계
 *    오차로 한 건이라도 새는 것보다, 같은 걸 여러 번 받는 편이 돈 데이터에서 안전하다.
 *  · 실패는 조용히 삼키지 않는다. 다만 일시적 실패는 다음 주기가 같은 구간을 다시 요청하므로
 *    자연히 수렴한다.
 */
@Injectable()
export class DepositSyncService {
  private logger = new Logger('DEPOSIT_SYNC');
  /** 앞 주기가 아직 안 끝났는데 다음 주기가 겹쳐 도는 것을 막는다(같은 구간 중복 왕복 방지). */
  private running = false;

  constructor(
    @InjectRepository(BankDepositEntity)
    private bankDepositRepository: Repository<BankDepositEntity>,
    private depositSourceHttp: DepositSourceHttp,
    private configService: ConfigService,
  ) {}

  isEnabled(): boolean {
    return this.configService.get('DEPOSIT_SYNC_ENABLED') === 'true';
  }

  /**
   * 주기 동기화 진입점.
   * 미러가 비어 있으면 전체 백필, 아니면 최근 N일 재동기화.
   */
  async syncRecent(): Promise<{ fetched: number; from: string; to: string } | null> {
    if (this.running) {
      this.logger.warn('이전 동기화가 아직 진행 중이라 이번 주기를 건너뜁니다.');
      return null;
    }

    this.running = true;
    try {
      const now = new Date();
      const to = format(now, DATE_FORMAT);
      const mirrorCount = await this.bankDepositRepository.count();

      const from =
        mirrorCount === 0
          ? this.configService.get<string>('DEPOSIT_SYNC_BACKFILL_FROM', DEFAULT_BACKFILL_FROM)
          : format(subDays(now, this.resyncDays()), DATE_FORMAT);

      if (mirrorCount === 0) {
        this.logger.log(`미러가 비어 있어 전체 백필을 수행합니다. from=${from}`);
      }

      const fetched = await this.syncRange(from, to);
      return { fetched, from, to };
    } finally {
      this.running = false;
    }
  }

  /**
   * 지정 구간을 페이지 단위로 받아 미러에 upsert 한다.
   * @returns 수신 건수(중복 포함)
   */
  async syncRange(from: string, to: string): Promise<number> {
    const size = Number(this.configService.get('DEPOSIT_SYNC_PAGE_SIZE', DEFAULT_PAGE_SIZE));
    const syncedAt = new Date();

    let page = 1;
    let fetched = 0;

    while (page <= MAX_PAGES) {
      const result = await this.depositSourceHttp.fetchPage(from, to, page, size);

      if (result.items.length === 0) {
        break;
      }

      await this.upsert(result.items, syncedAt);
      fetched += result.items.length;

      // 마지막 페이지 판정을 totalCount 산술이 아니라 "받은 개수 < 요청 개수" 로 한다.
      // 동기화 도중 원본에 새 행이 들어와 totalCount 가 움직여도 순회가 끝난다.
      if (result.items.length < size) {
        break;
      }
      page += 1;
    }

    if (page > MAX_PAGES) {
      this.logger.error(
        `페이지 상한(${MAX_PAGES})에 도달해 중단했습니다. 구간을 좁혀 백필하세요. from=${from} to=${to}`,
      );
    }

    this.logger.log(`동기화 완료: ${fetched}건 수신 (from=${from} to=${to})`);
    return fetched;
  }

  /**
   * dedup_key 충돌 시 원본 컬럼만 갱신한다.
   *
   * ⚠️ 갱신 컬럼을 명시적으로 열거하는 것이 이 메서드의 핵심이다.
   * 엔티티 전체를 save() 하거나 갱신 컬럼을 생략하면, 운영자가 방금 지정한
   * matched_user_id / match_status 가 다음 동기화에서 조용히 UNMATCHED 로 되돌아간다.
   * (같은 부류의 사고가 이 레포에서 이미 있었다 — save() 가 남이 쓴 상태를 stale 로 덮은 건)
   */
  private async upsert(items: DepositSourceItem[], syncedAt: Date): Promise<void> {
    const rows = items.map((item) => ({
      dedupKey: item.dedupKey,
      txDate: item.txDate,
      txType: item.txType,
      accountNo: item.accountNo,
      accountName: item.accountName,
      erpPartnerCode: item.erpPartnerCode,
      erpPartnerName: item.erpPartnerName,
      depositor: item.depositor,
      depositorRaw: item.depositorRaw,
      // BIGINT 컬럼이라 문자열로 넘긴다(JS number 정밀도에 기대지 않는다).
      amount: String(item.amount),
      balance: String(item.balance),
      voucherNo: item.voucherNo,
      sourceScrapedAt: new Date(item.scrapedAt),
      sourceUpdatedAt: new Date(item.updatedAt),
      syncedAt,
    }));

    await this.bankDepositRepository
      .createQueryBuilder()
      .insert()
      .into(BankDepositEntity)
      .values(rows)
      .orUpdate(
        [
          'tx_date',
          'tx_type',
          'account_no',
          'account_name',
          'erp_partner_code',
          'erp_partner_name',
          'depositor',
          'depositor_raw',
          'amount',
          'balance',
          'voucher_no',
          'source_scraped_at',
          'source_updated_at',
          'synced_at',
        ],
        ['dedup_key'],
      )
      .execute();
  }

  /**
   * 수집 상태.
   *
   * 왜 필요한가: 목록이 안 늘어날 때 그게 "오늘 입금이 없었다"인지 "수집이 죽었다"인지
   * 화면에서 구분할 수 없으면, 조용한 고장이 "입금이 안 들어왔다"는 잘못된 판단이 된다.
   *
   * 신호를 두 겹으로 둔다.
   *  · lastSyncedAt — 프리미엄 미러의 MAX(synced_at). **네트워크 없이 항상 답할 수 있다.**
   *    동기화 자체가 멈췄는지를 알려준다.
   *  · source — erp_macro 의 차단기 상태. 스크래퍼가 왜 멈췄는지까지 알려주지만,
   *    상대가 꺼져 있으면 못 받는다. 못 받아도 화면을 막지 않고 null 로 둔다.
   */
  async getSyncStatus(): Promise<{
    enabled: boolean;
    lastSyncedAt: Date | null;
    source: { gateTripped: boolean; gateReason: string | null; lastScrapedAt: string | null } | null;
  }> {
    const latest = await this.bankDepositRepository
      .createQueryBuilder('deposit')
      .select('MAX(deposit.synced_at)', 'lastSyncedAt')
      .getRawOne<{ lastSyncedAt: Date | null }>();

    return {
      enabled: this.isEnabled(),
      lastSyncedAt: latest?.lastSyncedAt ?? null,
      source: await this.fetchSourceStatusSafely(),
    };
  }

  /** 상대가 꺼져 있는 건 흔한 상황이라 예외로 올리지 않는다. 다만 차단 상태는 크게 남긴다. */
  private async fetchSourceStatusSafely() {
    try {
      const status = await this.depositSourceHttp.fetchStatus();
      if (status.gateTripped) {
        this.logger.error(`erp_macro 수집이 차단된 상태입니다: ${status.gateReason ?? '사유 미상'}`);
      }
      return {
        gateTripped: status.gateTripped,
        gateReason: status.gateReason,
        lastScrapedAt: status.lastScrapedAt,
      };
    } catch (error) {
      this.logger.warn(`수집 상태 조회 실패: ${(error as Error).message}`);
      return null;
    }
  }

  private resyncDays(): number {
    const configured = Number(this.configService.get('DEPOSIT_SYNC_RESYNC_DAYS', DEFAULT_RESYNC_DAYS));
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RESYNC_DAYS;
  }

  /** 설정 누락으로 인한 영구 실패는 스케줄러가 매번 시끄럽게 떠들 필요가 없도록 구분해 둔다. */
  static isPermanent(error: unknown): boolean {
    return error instanceof DepositSourcePermanentError;
  }
}
