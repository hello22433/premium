import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { format, subDays } from 'date-fns';
import { BankDepositEntity } from '../../entity/bank.deposit.entity';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DepositSourceHttp } from '../infra/deposit.source.http';
import { DepositSourceItem, DepositSourcePermanentError } from '../interface/deposit.source';

/** 한 요청에 받아올 건수. */
const DEFAULT_PAGE_SIZE = 500;
/**
 * 프리미엄 자체 상한. 상대 계약 상한은 2000 이지만(2026-08-05 확정) 실사용이 500 이라
 * 더 보수적인 값을 둔다. 상한이 필요한 이유는 순회 종료 조건이 `받은 개수 < 요청 개수` 라서다 —
 * 상대가 요청 size 를 자기 상한으로 말없이 깎으면 첫 페이지부터 종료 조건이 참이 되어
 * 한 페이지만 읽고 끝난다(에러 없이 데이터만 사라진다).
 */
const MAX_PAGE_SIZE = 1000;
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
    private cryptoCipher: CryptoCipher,
  ) {}

  /**
   * PII 저장 암호화. null/빈값은 그대로 둔다(빈 문자열을 암호화하면 의미 없는 암호문이 생기고,
   * 결정론적 스킴이라 "빈값"이 특정 암호문으로 고정돼 오히려 식별 가능해진다).
   */
  private encrypt(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    return this.cryptoCipher.encryptDeliveryTarget(value);
  }

  isEnabled(): boolean {
    return this.configService.get('DEPOSIT_SYNC_ENABLED') === 'true';
  }

  /**
   * 주기 동기화 진입점.
   *
   * 조회 구간을 **매 주기 원본 총계와 대조해서** 정한다. 미러가 원본보다 적으면 덜 받은
   * 것이므로 전체 백필, 같으면 최근 N일만 재동기화한다.
   *
   * ⚠️ 여기를 "미러가 비어 있으면 백필"로 두면 안 된다. 그 조건은 **한 번만 참**이라,
   * 첫 백필이 중간 페이지에서 실패하면(네트워크 등) 이미 커밋된 앞부분 때문에 다음
   * 주기부터는 최근 N일만 받게 되고, 실패 지점 ~ N일 전 구간이 **영구히 비면서
   * 아무도 감지하지 못한다.** 정렬이 오름차순이라 먼저 커밋되는 쪽이 과거 데이터라
   * 구멍은 항상 "중간"에 생기고, 돈 화면에서는 "그 기간에 입금이 없었다"로 읽힌다.
   *
   * 총계 대조는 size=1 요청 한 번이라 비용이 사실상 없고, 백필 갭뿐 아니라 중간
   * 누락까지 함께 메우는 자가 치유가 된다.
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
      const backfillFrom = this.configService.get<string>('DEPOSIT_SYNC_BACKFILL_FROM', DEFAULT_BACKFILL_FROM);

      const [mirrorCount, sourceTotal] = await Promise.all([
        this.bankDepositRepository.count(),
        this.fetchSourceTotal(backfillFrom, to),
      ]);

      // 원본이 미러보다 많으면 아직 못 받은 게 있다. (원본에서 행이 지워지면 반대가 되는데,
      // 그때는 백필해도 채울 게 없으므로 최근 구간만 도는 것이 맞다)
      const needsBackfill = mirrorCount < sourceTotal;
      const from = needsBackfill ? backfillFrom : format(subDays(now, this.resyncDays()), DATE_FORMAT);

      if (needsBackfill) {
        this.logger.log(
          `미러가 원본보다 ${sourceTotal - mirrorCount}건 적어 전체 백필을 수행합니다. ` +
            `(미러 ${mirrorCount} / 원본 ${sourceTotal}, from=${from})`,
        );
      }

      const fetched = await this.syncRange(from, to);
      return { fetched, from, to };
    } finally {
      this.running = false;
    }
  }

  /** 총계만 필요하므로 1건짜리 페이지를 받아 totalElements 만 읽는다. */
  private async fetchSourceTotal(from: string, to: string): Promise<number> {
    const page = await this.depositSourceHttp.fetchPage(from, to, 0, 1);
    return page.totalElements;
  }

  /**
   * 지정 구간을 페이지 단위로 받아 미러에 upsert 한다.
   * @returns 수신 건수(중복 포함)
   */
  async syncRange(from: string, to: string): Promise<number> {
    const size = this.pageSize();
    const syncedAt = new Date();

    // ⚠️ 상대는 Spring Pageable 이라 페이지가 0 부터 시작한다. 1 부터 보내면 첫 페이지가
    // 통째로 빠지는데, 에러 없이 데이터만 사라지므로 눈에 띄지 않는다.
    let page = 0;
    let fetched = 0;

    while (page < MAX_PAGES) {
      const result = await this.depositSourceHttp.fetchPage(from, to, page, size);

      if (result.content.length === 0) {
        break;
      }

      await this.upsert(result.content, syncedAt);
      fetched += result.content.length;

      // 마지막 페이지 판정을 totalElements 산술이 아니라 "받은 개수 < 요청 개수" 로 한다.
      // 동기화 도중 원본에 새 행이 들어와 총계가 움직여도 순회가 끝난다.
      if (result.content.length < size) {
        break;
      }
      page += 1;
    }

    if (page >= MAX_PAGES) {
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
   * matched_owner_type / matched_owner_id / match_status 가 다음 동기화에서 조용히 UNMATCHED 로 되돌아간다.
   * (같은 부류의 사고가 이 레포에서 이미 있었다 — save() 가 남이 쓴 상태를 stale 로 덮은 건)
   *
   * 원본이 값을 비우는 경우(회계반영 취소·거래처 detach)도 그대로 null 로 덮어써야 미러가
   * 거울로 유지된다. coalesce 하면 프리미엄만 옛 거래처를 붙들고 있게 된다.
   */
  private async upsert(items: DepositSourceItem[], syncedAt: Date): Promise<void> {
    const rows = items.map((item) => ({
      dedupKey: item.dedupKey,
      txDate: item.txDate,
      txType: item.txType,
      accountNo: item.accountNo,
      accountName: item.accountName,
      // PII 4종은 암호화해서 넣는다. 상대(erp_macro)가 자기 DB 에 암호화 보관하는 값이라
      // 미러도 같은 수준을 유지한다. 응답에서 다시 복호화하는 쪽은 DepositService 다.
      depositor: this.encrypt(item.depositor) as string,
      depositorRaw: this.encrypt(item.depositorRaw),
      erpPartnerCode: this.encrypt(item.erpPartnerCode),
      erpPartnerName: this.encrypt(item.erpPartnerName),
      // BIGINT 컬럼이라 문자열로 넘긴다(JS number 정밀도에 기대지 않는다).
      amount: String(item.amount),
      balance: String(item.balance),
      voucherNo: item.voucherNo,
      sourceScrapedAt: new Date(item.scrapedAt),
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
    source: {
      gateTripped: boolean;
      gateReason: string | null;
      lastScrapedAt: string | null;
      pollingEnabled: boolean | null;
    } | null;
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
        // 구버전 응답에는 없는 필드다. 없으면 "모름"이지 "꺼짐"이 아니므로 null 로 둔다.
        pollingEnabled: status.pollingEnabled ?? null,
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

  /**
   * 페이지 크기를 계약 상한(1000) 안으로 강제한다.
   *
   * 종료 조건이 "받은 개수 < 요청 개수"라, 상대가 요청 size 를 자기 상한으로 깎으면
   * 첫 페이지에서 조건이 참이 되어 **1페이지만 받고 정상 종료로 보인다**(에러 없음).
   * 빈 env 는 Number('')=0 이 되어 반대로 종료 조건이 영원히 거짓이 된다.
   * 둘 다 조용히 틀리는 방향이라 입구에서 막는다.
   */
  private pageSize(): number {
    const configured = Number(this.configService.get('DEPOSIT_SYNC_PAGE_SIZE', DEFAULT_PAGE_SIZE));
    if (!Number.isFinite(configured) || configured < 1) {
      return DEFAULT_PAGE_SIZE;
    }
    return Math.min(Math.floor(configured), MAX_PAGE_SIZE);
  }

  /** 설정 누락으로 인한 영구 실패는 스케줄러가 매번 시끄럽게 떠들 필요가 없도록 구분해 둔다. */
  static isPermanent(error: unknown): boolean {
    return error instanceof DepositSourcePermanentError;
  }
}
