import { DepositSyncService } from './deposit.sync.service';
import {
  DepositSourceItem,
  DepositSourcePermanentError,
  DepositSourceTransientError,
} from '../interface/deposit.source';

/**
 * 미러 동기화 회귀 테스트.
 *
 * 이 배치의 사고는 전부 "조용히 틀리는" 종류다. 특히 두 가지를 고정한다.
 *  · 동기화가 프리미엄 소유 컬럼(matched_user_id/match_status)을 덮지 않을 것.
 *    덮으면 운영자가 방금 지정한 매칭이 5분 뒤 UNMATCHED 로 되돌아간다.
 *  · 페이지 순회가 끝날 것. 마지막 페이지 판정을 totalCount 산술로 하면 동기화 도중
 *    원본에 행이 추가될 때 끝나지 않거나 일부를 건너뛴다.
 */
describe('DepositSyncService', () => {
  /**
   * 상대(erp_macro DepositView)가 실제로 돌려주는 필드만 담는다.
   * depositorRaw / erpPartnerCode 는 현재 응답에 **없다** — 없는 상태가 기본이다.
   */
  const item = (overrides: Partial<DepositSourceItem> = {}): DepositSourceItem => ({
    id: 4712,
    dedupKey: 'f57b73d0',
    txDate: '2026-07-29',
    txType: '입금',
    accountNo: '280***01757104',
    accountName: '(주)모바일이앤엠애드',
    erpPartnerName: null,
    depositor: '두성종이',
    amount: 350000,
    balance: 45717465,
    voucherNo: '2026/07/29-2',
    scrapedAt: '2026-08-04T05:47:00.123456Z',
    ...overrides,
  });

  const buildSut = (options: {
    pages?: DepositSourceItem[][];
    mirrorCount?: number;
    config?: Record<string, string>;
  }) => {
    const insertCalls: { rows: any[]; overwrite: string[]; conflict: string[] }[] = [];

    const insertQb: any = {
      insert: jest.fn(() => insertQb),
      into: jest.fn(() => insertQb),
      values: jest.fn((rows: any[]) => {
        insertQb._rows = rows;
        return insertQb;
      }),
      orUpdate: jest.fn((overwrite: string[], conflict: string[]) => {
        insertCalls.push({ rows: insertQb._rows, overwrite, conflict });
        return insertQb;
      }),
      execute: jest.fn(async () => ({})),
      select: jest.fn(() => insertQb),
      getRawOne: jest.fn(async () => ({ lastSyncedAt: null })),
    };

    const repository: any = {
      count: jest.fn(async () => options.mirrorCount ?? 1),
      createQueryBuilder: jest.fn(() => insertQb),
    };

    // 상대는 Spring Pageable — page 는 0-based 이고 봉투는 content/totalElements 다.
    const pages = options.pages ?? [[]];
    const fetchPage = jest.fn(async (_from: string, _to: string, page: number, size: number) => {
      const content = pages[page] ?? [];
      return { content, number: page, size, totalElements: pages.flat().length, totalPages: pages.length };
    });

    const sourceHttp: any = { fetchPage, fetchStatus: jest.fn() };
    const config: any = {
      get: jest.fn((key: string, fallback?: unknown) => options.config?.[key] ?? fallback),
    };

    // 결정론적이고 되돌릴 수 있는 가짜 암호화 — 실제 스킴과 성질이 같다.
    const cryptoCipher: any = { encryptDeliveryTarget: jest.fn((plain: string) => `enc(${plain})`) };

    return {
      sut: new DepositSyncService(repository, sourceHttp, config, cryptoCipher),
      insertCalls,
      fetchPage,
      repository,
    };
  };

  describe('upsert 컬럼 소유권', () => {
    it('충돌 시 갱신 컬럼에 matched_user_id / match_status 가 없다 (매칭 되돌림 방지)', async () => {
      const { sut, insertCalls } = buildSut({ pages: [[item()]] });

      await sut.syncRange('2026-07-01', '2026-07-31');

      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0].overwrite).not.toContain('matched_user_id');
      expect(insertCalls[0].overwrite).not.toContain('match_status');
    });

    it('충돌 키는 dedup_key 이고, 원본 컬럼은 갱신 대상에 포함된다', async () => {
      const { sut, insertCalls } = buildSut({ pages: [[item()]] });

      await sut.syncRange('2026-07-01', '2026-07-31');

      expect(insertCalls[0].conflict).toEqual(['dedup_key']);
      expect(insertCalls[0].overwrite).toEqual(
        expect.arrayContaining(['tx_date', 'amount', 'balance', 'voucher_no', 'source_scraped_at', 'synced_at']),
      );
    });

    it('dedup_key 자체는 갱신하지 않는다 (충돌 대상이라 덮을 이유가 없다)', async () => {
      const { sut, insertCalls } = buildSut({ pages: [[item()]] });

      await sut.syncRange('2026-07-01', '2026-07-31');

      expect(insertCalls[0].overwrite).not.toContain('dedup_key');
    });
  });

  describe('값 변환', () => {
    it('BIGINT 컬럼에 넣을 금액을 문자열로 넘긴다 (number 정밀도에 기대지 않음)', async () => {
      const { sut, insertCalls } = buildSut({ pages: [[item({ amount: 350000, balance: 45717465 })]] });

      await sut.syncRange('2026-07-01', '2026-07-31');

      expect(insertCalls[0].rows[0].amount).toBe('350000');
      expect(insertCalls[0].rows[0].balance).toBe('45717465');
    });

    it("txDate 는 'yyyy-MM-dd' 문자열 그대로 저장한다 (Date 변환 시 하루 밀림)", async () => {
      const { sut, insertCalls } = buildSut({ pages: [[item({ txDate: '2026-07-29' })]] });

      await sut.syncRange('2026-07-01', '2026-07-31');

      expect(insertCalls[0].rows[0].txDate).toBe('2026-07-29');
    });

    it('Java Instant(UTC Z) 문자열을 Date 로 변환한다', async () => {
      const { sut, insertCalls } = buildSut({
        pages: [[item({ scrapedAt: '2026-08-04T05:47:00.123456Z' })]],
      });

      await sut.syncRange('2026-07-01', '2026-07-31');

      expect(insertCalls[0].rows[0].sourceScrapedAt).toEqual(new Date('2026-08-04T05:47:00.123456Z'));
    });

    it('응답에 없는 depositorRaw / erpPartnerCode 는 null 로 저장한다 (상대 미노출 필드)', async () => {
      const { sut, insertCalls } = buildSut({ pages: [[item()]] });

      await sut.syncRange('2026-07-01', '2026-07-31');

      expect(insertCalls[0].rows[0].depositorRaw).toBeNull();
      expect(insertCalls[0].rows[0].erpPartnerCode).toBeNull();
    });

    /**
     * 상대(erp_macro)가 자기 DB 에 암호화 보관하는 값이라 미러도 같은 수준을 유지한다.
     * 평문이 그대로 들어가면 원본보다 보호 수준이 낮은 사본이 생긴다.
     */
    it('PII 4종을 암호화해 저장한다', async () => {
      const { sut, insertCalls } = buildSut({
        pages: [
          [
            item({
              depositor: '두성종이',
              depositorRaw: '(가상)  두성종이',
              erpPartnerName: '두성종이(주)',
              erpPartnerCode: 'P-001',
            }),
          ],
        ],
      });

      await sut.syncRange('2026-07-01', '2026-07-31');

      const stored = insertCalls[0].rows[0];
      expect(stored.depositor).toBe('enc(두성종이)');
      expect(stored.depositorRaw).toBe('enc((가상)  두성종이)');
      expect(stored.erpPartnerName).toBe('enc(두성종이(주))');
      expect(stored.erpPartnerCode).toBe('enc(P-001)');
    });

    it('PII 가 아닌 값(계좌번호·금액)은 암호화하지 않는다', async () => {
      const { sut, insertCalls } = buildSut({ pages: [[item()]] });

      await sut.syncRange('2026-07-01', '2026-07-31');

      const stored = insertCalls[0].rows[0];
      expect(stored.accountNo).toBe('280***01757104');
      expect(stored.amount).toBe('350000');
    });

    // 결정론적 스킴이라 빈 문자열을 암호화하면 "빈값"이 특정 암호문으로 고정돼 오히려 식별된다.
    it('빈 문자열은 암호화하지 않고 null 로 둔다', async () => {
      const { sut, insertCalls } = buildSut({ pages: [[item({ depositorRaw: '' })]] });

      await sut.syncRange('2026-07-01', '2026-07-31');

      expect(insertCalls[0].rows[0].depositorRaw).toBeNull();
    });

    // ECOUNT 원장에는 입금처가 비는 행이 있다(수수료·자동이체 등 출금 계열).
    // 예전에는 NOT NULL 컬럼에 `as string` 으로 밀어 넣어서, 그런 행 하나가 500행짜리
    // multi-row INSERT 전체를 되돌렸다. 백필이 매 주기 같은 자리에서 죽어 미러가 영원히
    // 수렴하지 못했고, 로그는 "일시 실패 — 재시도합니다"라고 찍혀 정지가 드러나지도 않았다.
    it('입금처가 비어도 그 행을 버리지 않고 null 로 적재한다 (한 행이 배치 전체를 죽이지 않게)', async () => {
      const { sut, insertCalls } = buildSut({
        pages: [[item({ dedupKey: 'empty', depositor: '' }), item({ dedupKey: 'normal', depositor: '두성종이' })]],
      });

      await sut.syncRange('2026-07-01', '2026-07-31');

      const rows = insertCalls[0].rows;
      expect(rows).toHaveLength(2); // 빈 행을 걸러내면 원본과 건수가 달라져 백필이 영원히 재시도된다
      expect(rows[0].depositor).toBeNull();
      expect(rows[1].depositor).not.toBeNull();
    });

    it('한 번의 동기화 안에서는 모든 행이 같은 syncedAt 을 갖는다', async () => {
      const { sut, insertCalls } = buildSut({
        pages: [Array.from({ length: 500 }, (_, i) => item({ dedupKey: `k${i}` })), [item({ dedupKey: 'last' })]],
      });

      await sut.syncRange('2026-07-01', '2026-07-31');

      const stamps = insertCalls.flatMap((call) => call.rows.map((row: any) => row.syncedAt.getTime()));
      expect(new Set(stamps).size).toBe(1);
    });
  });

  describe('페이지 순회', () => {
    // 상대가 Spring Pageable 이라 첫 페이지가 0 이다. 1 부터 보내면 최신 한 페이지가
    // 통째로 빠지는데 에러가 없어 눈에 띄지 않는다 — 실제로 한 번 틀렸던 지점이라 고정한다.
    it('첫 요청의 페이지 번호는 0 이다 (Spring Pageable, 0-based)', async () => {
      const { sut, fetchPage } = buildSut({ pages: [[item()]] });

      await sut.syncRange('2026-07-01', '2026-07-31');

      expect(fetchPage.mock.calls[0][2]).toBe(0);
    });

    it('받은 개수가 요청 개수보다 적으면 마지막 페이지로 보고 멈춘다', async () => {
      const { sut, fetchPage } = buildSut({ pages: [[item({ dedupKey: 'a' })]] });

      const fetched = await sut.syncRange('2026-07-01', '2026-07-31');

      expect(fetched).toBe(1);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('가득 찬 페이지면 다음 페이지를 이어서 요청한다', async () => {
      const full = Array.from({ length: 500 }, (_, i) => item({ dedupKey: `k${i}` }));
      const { sut, fetchPage } = buildSut({ pages: [full, [item({ dedupKey: 'tail' })]] });

      const fetched = await sut.syncRange('2026-07-01', '2026-07-31');

      expect(fetched).toBe(501);
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls.map((call) => call[2])).toEqual([0, 1]);
    });

    it('빈 페이지를 받으면 즉시 멈추고 쓰기를 하지 않는다', async () => {
      const { sut, insertCalls, fetchPage } = buildSut({ pages: [[]] });

      const fetched = await sut.syncRange('2026-07-01', '2026-07-31');

      expect(fetched).toBe(0);
      expect(insertCalls).toHaveLength(0);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });
  });

  describe('조회 구간 결정 (원본 총계 대조)', () => {
    const daysBetween = (from?: string, to?: string) =>
      Math.round(
        (new Date(`${to}T00:00:00+09:00`).getTime() - new Date(`${from}T00:00:00+09:00`).getTime()) / 86_400_000,
      );

    it('미러가 비어 있으면 백필 시작일부터 받아온다', async () => {
      const { sut } = buildSut({
        pages: [[item()]],
        mirrorCount: 0,
        config: { DEPOSIT_SYNC_BACKFILL_FROM: '2020-01-01' },
      });

      const result = await sut.syncRecent();

      expect(result?.from).toBe('2020-01-01');
    });

    /**
     * 회귀: 백필이 중간에 실패하면 미러가 "비어 있지 않은" 상태로 남는다. 그때 판정 기준이
     * `mirrorCount === 0` 이면 다음 주기부터 최근 N일만 받게 되고, 실패 지점 ~ N일 전 구간이
     * 영구히 비면서 아무도 감지하지 못한다. 총계를 대조해 계속 백필해야 한다.
     */
    it('미러에 데이터가 있어도 원본보다 적으면 백필을 이어서 한다 (백필 중단 자가 치유)', async () => {
      const { sut } = buildSut({
        pages: [Array.from({ length: 500 }, (_, i) => item({ dedupKey: `k${i}` }))],
        mirrorCount: 120, // 앞선 백필이 120건까지만 커밋되고 실패한 상황
        config: { DEPOSIT_SYNC_BACKFILL_FROM: '2020-01-01' },
      });

      const result = await sut.syncRecent();

      expect(result?.from).toBe('2020-01-01');
    });

    it('미러와 원본 건수가 같으면 최근 N일만 다시 받아온다', async () => {
      const { sut } = buildSut({
        pages: [[item()]],
        mirrorCount: 1,
        config: { DEPOSIT_SYNC_RESYNC_DAYS: '7' },
      });

      const result = await sut.syncRecent();

      expect(daysBetween(result?.from, result?.to)).toBe(7);
    });

    it('원본에서 행이 지워져 미러가 더 많아도 백필하지 않는다 (채울 게 없다)', async () => {
      const { sut } = buildSut({
        pages: [[item()]],
        mirrorCount: 50,
        config: { DEPOSIT_SYNC_RESYNC_DAYS: '7' },
      });

      const result = await sut.syncRecent();

      expect(daysBetween(result?.from, result?.to)).toBe(7);
    });

    it('RESYNC_DAYS 가 이상한 값이면 기본값으로 되돌린다', async () => {
      const { sut } = buildSut({
        pages: [[item()]],
        mirrorCount: 1,
        config: { DEPOSIT_SYNC_RESYNC_DAYS: 'abc' },
      });

      const result = await sut.syncRecent();

      expect(daysBetween(result?.from, result?.to)).toBe(30);
    });
  });

  describe('중복 실행 방지', () => {
    it('앞 주기가 진행 중이면 이번 주기를 건너뛴다', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { sut, repository } = buildSut({ pages: [[item()]] });
      repository.count.mockImplementationOnce(async () => {
        await gate;
        return 1;
      });

      const first = sut.syncRecent();
      const second = await sut.syncRecent();

      expect(second).toBeNull();

      release();
      await first;
    });

    it('실패해도 실행 잠금이 풀려 다음 주기가 돌 수 있다', async () => {
      const { sut, repository } = buildSut({ pages: [[item()]] });
      repository.count.mockRejectedValueOnce(new Error('DB 접속 실패'));

      await expect(sut.syncRecent()).rejects.toThrow('DB 접속 실패');

      await expect(sut.syncRecent()).resolves.not.toBeNull();
    });
  });

  describe('실패 분류', () => {
    it('영구 실패는 영구로 판정한다 (재시도 무의미)', () => {
      expect(DepositSyncService.isPermanent(new DepositSourcePermanentError('키 없음'))).toBe(true);
    });

    it('일시 실패는 영구가 아니다 (다음 주기 재시도)', () => {
      expect(DepositSyncService.isPermanent(new DepositSourceTransientError('타임아웃'))).toBe(false);
    });
  });

  describe('수집 상태', () => {
    it('스크래핑 서버에 닿지 못해도 lastSyncedAt 은 응답한다 (화면을 막지 않는다)', async () => {
      const { sut } = buildSut({ pages: [[item()]] });
      const lastSyncedAt = new Date('2026-08-03T10:00:00+09:00');
      (sut as any).bankDepositRepository.createQueryBuilder = jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn(async () => ({ lastSyncedAt })),
      }));
      (sut as any).depositSourceHttp.fetchStatus = jest.fn(async () => {
        throw new DepositSourceTransientError('연결 거부');
      });

      const status = await sut.getSyncStatus();

      expect(status.lastSyncedAt).toEqual(lastSyncedAt);
      expect(status.source).toBeNull();
    });

    const stubStatus = (sut: any, sourceStatus: unknown) => {
      sut.bankDepositRepository.createQueryBuilder = jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn(async () => ({ lastSyncedAt: null })),
      }));
      sut.depositSourceHttp.fetchStatus = jest.fn(async () => sourceStatus);
    };

    it('차단 상태를 그대로 전달한다', async () => {
      const { sut } = buildSut({ pages: [[item()]] });
      stubStatus(sut, {
        lastScrapedAt: '2026-08-04T05:47:00.123456Z',
        gateTripped: true,
        gateReason: '기기 재등록 필요',
        pollingEnabled: true,
      });

      const status = await sut.getSyncStatus();

      expect(status.source).toEqual({
        gateTripped: true,
        gateReason: '기기 재등록 필요',
        lastScrapedAt: '2026-08-04T05:47:00.123456Z',
        pollingEnabled: true,
      });
    });

    // pollingEnabled 미지원 응답에서 false 로 접으면 "폴링이 꺼져 있다"는 잘못된 경고가 뜬다.
    it('상대가 pollingEnabled 를 안 주면 false 가 아니라 null 로 둔다 (모름 ≠ 꺼짐)', async () => {
      const { sut } = buildSut({ pages: [[item()]] });
      stubStatus(sut, { lastScrapedAt: null, gateTripped: false, gateReason: null });

      const status = await sut.getSyncStatus();

      expect(status.source?.pollingEnabled).toBeNull();
    });
  });
});
