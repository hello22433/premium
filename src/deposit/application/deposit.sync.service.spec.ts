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
  const item = (overrides: Partial<DepositSourceItem> = {}): DepositSourceItem => ({
    dedupKey: 'f57b73d0',
    txDate: '2026-07-29',
    txType: '입금',
    accountNo: '280***01757104',
    accountName: '(주)모바일이앤엠애드',
    erpPartnerCode: null,
    erpPartnerName: null,
    depositor: '두성종이',
    depositorRaw: '(가상)  두성종이',
    amount: 350000,
    balance: 45717465,
    voucherNo: '2026/07/29-2',
    scrapedAt: '2026-08-03T10:35:51.995+09:00',
    updatedAt: '2026-08-03T10:35:52.479+09:00',
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

    const pages = options.pages ?? [[]];
    const fetchPage = jest.fn(async (_from: string, _to: string, page: number) => {
      const items = pages[page - 1] ?? [];
      return { items, page, size: 500, totalCount: pages.flat().length };
    });

    const sourceHttp: any = { fetchPage, fetchStatus: jest.fn() };
    const config: any = {
      get: jest.fn((key: string, fallback?: unknown) => options.config?.[key] ?? fallback),
    };

    return { sut: new DepositSyncService(repository, sourceHttp, config), insertCalls, fetchPage, repository };
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
        expect.arrayContaining(['tx_date', 'amount', 'balance', 'voucher_no', 'source_updated_at', 'synced_at']),
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

    it('오프셋이 붙은 시각 문자열을 Date 로 변환한다', async () => {
      const { sut, insertCalls } = buildSut({
        pages: [[item({ scrapedAt: '2026-08-03T10:35:51.995+09:00' })]],
      });

      await sut.syncRange('2026-07-01', '2026-07-31');

      expect(insertCalls[0].rows[0].sourceScrapedAt).toEqual(new Date('2026-08-03T10:35:51.995+09:00'));
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
    });

    it('빈 페이지를 받으면 즉시 멈추고 쓰기를 하지 않는다', async () => {
      const { sut, insertCalls, fetchPage } = buildSut({ pages: [[]] });

      const fetched = await sut.syncRange('2026-07-01', '2026-07-31');

      expect(fetched).toBe(0);
      expect(insertCalls).toHaveLength(0);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });
  });

  describe('조회 구간 결정', () => {
    it('미러가 비어 있으면 백필 시작일부터 받아온다', async () => {
      const { sut, fetchPage } = buildSut({
        pages: [[item()]],
        mirrorCount: 0,
        config: { DEPOSIT_SYNC_BACKFILL_FROM: '2020-01-01' },
      });

      const result = await sut.syncRecent();

      expect(result?.from).toBe('2020-01-01');
      expect(fetchPage.mock.calls[0][0]).toBe('2020-01-01');
    });

    it('미러에 데이터가 있으면 최근 N일만 다시 받아온다', async () => {
      const { sut } = buildSut({
        pages: [[item()]],
        mirrorCount: 100,
        config: { DEPOSIT_SYNC_RESYNC_DAYS: '7' },
      });

      const result = await sut.syncRecent();

      const from = new Date(`${result?.from}T00:00:00+09:00`);
      const to = new Date(`${result?.to}T00:00:00+09:00`);
      const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
      expect(days).toBe(7);
    });

    it('RESYNC_DAYS 가 이상한 값이면 기본값으로 되돌린다', async () => {
      const { sut } = buildSut({
        pages: [[item()]],
        mirrorCount: 100,
        config: { DEPOSIT_SYNC_RESYNC_DAYS: 'abc' },
      });

      const result = await sut.syncRecent();

      const from = new Date(`${result?.from}T00:00:00+09:00`);
      const to = new Date(`${result?.to}T00:00:00+09:00`);
      expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(30);
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

    it('차단 상태를 그대로 전달한다', async () => {
      const { sut } = buildSut({ pages: [[item()]] });
      (sut as any).bankDepositRepository.createQueryBuilder = jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn(async () => ({ lastSyncedAt: null })),
      }));
      (sut as any).depositSourceHttp.fetchStatus = jest.fn(async () => ({
        lastScrapedAt: '2026-08-03T10:35:51.995+09:00',
        gateTripped: true,
        gateReason: '기기 재등록 필요',
      }));

      const status = await sut.getSyncStatus();

      expect(status.source).toEqual({
        gateTripped: true,
        gateReason: '기기 재등록 필요',
        lastScrapedAt: '2026-08-03T10:35:51.995+09:00',
      });
    });
  });
});
