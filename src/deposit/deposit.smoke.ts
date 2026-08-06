/**
 * 입금내역 미러 스모크 — 실제 MySQL 에 붙여 검증한다.
 *
 * 단위 테스트는 QueryBuilder 를 모킹하므로 다음 두 가지를 검증하지 못한다.
 *   ① migration/bank-deposit-mirror.sql 의 DDL 과 BankDepositEntity 가 실제로 맞는가
 *   ② upsert 가 프리미엄 소유 컬럼(matched_owner_type/matched_owner_id/match_status)을 정말 보존하는가
 *      — 이건 SQL 이 만들어지는 방식의 문제라 모킹으로는 절대 잡을 수 없다.
 * 이 스크립트는 그 둘만 실제 DB 로 확인한다.
 *
 * 안전: 일회용 데이터베이스(epopkon_deposit_smoke)를 만들고 끝나면 지운다.
 *       기존 epopkon DB 는 건드리지 않는다.
 *
 * 실행: npx ts-node -r tsconfig-paths/register src/deposit/deposit.smoke.ts
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { BankDepositEntity } from '../entity/bank.deposit.entity';
import { CryptoCipher } from '../common/infra/crypto.cipher';
import { DepositService } from './application/deposit.service';
import { DepositSyncService } from './application/deposit.sync.service';
import { DepositMatchStatus } from './interface/deposit.match.status';
import { DepositSourceItem } from './interface/deposit.source';

process.env.TZ = 'Asia/Seoul';

const SMOKE_DATABASE = 'epopkon_deposit_smoke';
const ROOT = path.join(__dirname, '../..');

const parseEnv = (file: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

const env = parseEnv(path.join(ROOT, '.env.local'));

let failed = 0;
const check = (label: string, ok: boolean, detail: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${JSON.stringify(detail)}`);
  if (!ok) failed += 1;
};
/** getList 는 감사 맥락을 필수로 받는다(무감사 호출을 타입으로 막는다). */
const SMOKE_AUDIT = {
  user: { id: 0, email: 'smoke@local', authority: 'SUPER_ADMIN' } as any,
  ipAddress: '127.0.0.1',
  userAgent: 'smoke',
};

/** 상대 DepositView 가 실제로 돌려주는 필드만. depositorRaw/erpPartnerCode 는 없다. */
const item = (overrides: Partial<DepositSourceItem> = {}): DepositSourceItem => ({
  id: 4712,
  dedupKey: 'aaaa1111',
  txDate: '2026-07-29',
  txType: '입금',
  accountNo: '280***01757104',
  accountName: '(주)모바일이앤엠애드',
  erpPartnerName: null,
  depositor: '두성종이',
  amount: 350000,
  balance: 45717465,
  voucherNo: null,
  scrapedAt: '2026-08-04T05:47:00.123456Z',
  ...overrides,
});

/** 가짜 erp_macro. Spring Page 봉투 + 0-based 페이지를 그대로 흉내낸다. */
const fakeSource = (items: DepositSourceItem[]) => ({
  fetchPage: async (_from: string, _to: string, page: number, size: number) => ({
    content: page === 0 ? items : [],
    number: page,
    size,
    totalElements: items.length,
    totalPages: 1,
  }),
  fetchStatus: async () => ({ lastScrapedAt: null, gateTripped: false, gateReason: null }),
});

const fakeConfig = (values: Record<string, string> = {}) => ({
  get: (key: string, fallback?: unknown) => values[key] ?? fallback,
});

(async () => {
  const base = {
    type: 'mysql' as const,
    host: env.DATABASE_HOST,
    port: +env.DATABASE_PORT,
    username: env.DATABASE_USERNAME,
    password: env.DATABASE_PASSWORD,
  };

  // 1) 일회용 DB 생성
  const admin = new DataSource({ ...base, database: undefined as any });
  await admin.initialize();
  await admin.query(`DROP DATABASE IF EXISTS \`${SMOKE_DATABASE}\``);
  await admin.query(`CREATE DATABASE \`${SMOKE_DATABASE}\` DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.destroy();

  const dataSource = new DataSource({
    ...base,
    database: SMOKE_DATABASE,
    entities: [BankDepositEntity],
    timezone: '+09:00',
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false, // DDL 은 마이그레이션 파일이 정본이다. 엔티티로 만들면 검증이 무의미해진다.
    logging: false,
  });
  await dataSource.initialize();

  try {
    // 2) 마이그레이션 SQL 을 그대로 적용 (엔티티↔DDL 정합 검증의 출발점)
    const sql = fs.readFileSync(path.join(ROOT, 'migration/bank-deposit-mirror.sql'), 'utf8');
    const statements = sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await dataSource.query(statement);
    }
    check('마이그레이션 DDL 적용', true, `${statements.length}개 statement`);

    const repository = dataSource.getRepository(BankDepositEntity);
    // 실제 CryptoCipher 를 쓴다 — 암호화 저장 → 복호화 조회 왕복이 실제 키로 성립하는지 본다.
    const cryptoCipher = new CryptoCipher({ getOrThrow: (k: string) => env[k] } as any);
    const walletRepository = { createQueryBuilder: () => ({ getRawMany: async () => [] }) } as any;
    const activityLog = { createLog: async () => 1 } as any;
    const listService = new DepositService(repository, walletRepository, cryptoCipher, activityLog);

    // 3) 최초 동기화 — 2건 수신
    const first = [
      item({ dedupKey: 'aaaa1111' }),
      item({ dedupKey: 'bbbb2222', depositor: '한빛문구', amount: 12000 }),
    ];
    const syncService = new DepositSyncService(repository, fakeSource(first) as any, fakeConfig() as any, cryptoCipher);
    await syncService.syncRange('2026-07-01', '2026-07-31');

    const afterFirst = await listService.getList({ page: 1, take: 10 } as any, SMOKE_AUDIT);
    check('최초 동기화 2건 저장', afterFirst.totalCount === 2, afterFirst.totalCount);
    check(
      '엔티티↔DDL 정합 (전 컬럼 왕복)',
      afterFirst.list[0].depositor.length > 0 && typeof afterFirst.list[0].amount === 'number',
      { depositor: afterFirst.list[0].depositor, amount: afterFirst.list[0].amount },
    );

    // ⭐ PII 는 DB 에 암호문으로 있고 응답에서만 평문이어야 한다.
    const [rawRow] = await dataSource.query(
      "SELECT depositor, depositor_raw FROM bank_deposit WHERE dedup_key = 'bbbb2222'",
    );
    check(
      '⭐ DB 에는 암호문으로 저장된다 (평문 노출 없음)',
      rawRow.depositor !== '한빛문구' && !String(rawRow.depositor).includes('한빛'),
      { stored: String(rawRow.depositor).slice(0, 24) + '…' },
    );
    check(
      '⭐ 응답에서는 복호화된 평문이 나온다',
      afterFirst.list.some((r) => r.depositor === '한빛문구'),
      afterFirst.list.map((r) => r.depositor),
    );
    check(
      '입금처 부분검색이 암호화 컬럼 위에서 동작한다',
      (await listService.getList({ page: 1, take: 10, depositor: '한빛' } as any, SMOKE_AUDIT)).totalCount === 1,
      (await listService.getList({ page: 1, take: 10, depositor: '한빛' } as any, SMOKE_AUDIT)).totalCount,
    );
    check(
      "tx_date 가 'yyyy-MM-dd' 문자열",
      /^\d{4}-\d{2}-\d{2}$/.test(afterFirst.list[0].txDate),
      afterFirst.list[0].txDate,
    );
    check(
      '신규 행의 기본 매칭상태는 UNMATCHED',
      afterFirst.list[0].matchStatus === DepositMatchStatus.UNMATCHED,
      afterFirst.list[0].matchStatus,
    );

    // 4) 운영자가 한 건을 고객에 매칭했다고 가정 (앞으로 프리미엄이 하게 될 일)
    await repository.update(
      { dedupKey: 'aaaa1111' },
      { matchedOwnerType: 'SETTLEMENT_CODE', matchedOwnerId: 'company-7', matchStatus: DepositMatchStatus.MAPPED },
    );

    // 5) 다음 주기 동기화 — 같은 건이 다시 오고, 회계전표가 뒤늦게 채워짐
    const second = [
      item({ dedupKey: 'aaaa1111', voucherNo: '2026/07/29-2' }),
      item({ dedupKey: 'bbbb2222', depositor: '한빛문구', amount: 12000 }),
    ];
    const secondSync = new DepositSyncService(repository, fakeSource(second) as any, fakeConfig() as any, cryptoCipher);
    await secondSync.syncRange('2026-07-01', '2026-07-31');

    const matched = await repository.findOneByOrFail({ dedupKey: 'aaaa1111' });

    // ===== 이 스크립트의 핵심 =====
    check('재동기화해도 행이 늘지 않는다 (dedup_key 멱등)', (await repository.count()) === 2, await repository.count());
    check(
      '⭐ 운영자가 지정한 matched_owner_type/id 가 보존된다',
      matched.matchedOwnerType === 'SETTLEMENT_CODE' && matched.matchedOwnerId === 'company-7',
      { type: matched.matchedOwnerType, id: matched.matchedOwnerId },
    );
    check(
      '⭐ 운영자가 지정한 match_status 가 보존된다',
      matched.matchStatus === DepositMatchStatus.MAPPED,
      matched.matchStatus,
    );
    check('원본 컬럼(voucher_no)은 갱신된다', matched.voucherNo === '2026/07/29-2', matched.voucherNo);

    // 5-b) ⭐ 원본이 값을 되돌리면(회계반영 취소·거래처 detach) 미러도 null 로 따라가는가.
    //      erp_macro 회신 §2-B 의 확인 요청. "null 이면 기존값 유지(coalesce)" 라면 미러가
    //      옛 거래처를 붙들고 있어 원본과 어긋난다. 덮어써야 거울이 유지된다.
    const reverted = [
      item({ dedupKey: 'aaaa1111', voucherNo: null, erpPartnerName: null, erpPartnerCode: null }),
      item({ dedupKey: 'bbbb2222', depositor: '한빛문구', amount: 12000 }),
    ];
    await new DepositSyncService(repository, fakeSource(reverted) as any, fakeConfig() as any, cryptoCipher).syncRange(
      '2026-07-01',
      '2026-07-31',
    );
    const afterRevert = await repository.findOneByOrFail({ dedupKey: 'aaaa1111' });

    check(
      '⭐ 원본이 voucher_no 를 되돌리면 미러도 null 이 된다',
      afterRevert.voucherNo === null,
      afterRevert.voucherNo,
    );
    check(
      '⭐ 원본이 거래처를 떼면 미러도 null 이 된다',
      afterRevert.erpPartnerName === null && afterRevert.erpPartnerCode === null,
      { name: afterRevert.erpPartnerName, code: afterRevert.erpPartnerCode },
    );
    check(
      '되돌림 동기화에도 운영자 매칭은 여전히 보존된다',
      afterRevert.matchedOwnerType === 'SETTLEMENT_CODE' &&
        afterRevert.matchedOwnerId === 'company-7' &&
        afterRevert.matchStatus === DepositMatchStatus.MAPPED,
      { type: afterRevert.matchedOwnerType, id: afterRevert.matchedOwnerId, status: afterRevert.matchStatus },
    );

    // 5-c) ⭐ 다형 참조(타입+id 쌍)의 반쪽 행을 DB 가 막는가.
    //      한쪽만 채워진 행은 표시명 조회에서 조용히 null 이 되어 미매칭처럼 보인다.
    //      CHECK 제약은 MySQL 8.0.16+ 에서만 실제로 강제되므로 실 DB 로만 확인 가능하다.
    let halfMatchRejected = false;
    try {
      await repository.update({ dedupKey: 'bbbb2222' }, { matchedOwnerId: 'company-9' });
    } catch {
      halfMatchRejected = true;
    }
    check(
      '⭐ 타입 없이 id 만 채운 반쪽 매칭을 DB CHECK 가 거부한다',
      halfMatchRejected,
      halfMatchRejected ? 'rejected' : (await repository.findOneByOrFail({ dedupKey: 'bbbb2222' })).matchedOwnerId,
    );

    // 6) 계좌 집계
    const accounts = await listService.getAccountList();
    check('계좌 집계', accounts.accounts.length === 1 && accounts.accounts[0].count === 2, accounts.accounts);

    // 7) 수집 상태 — 미러의 synced_at 이 항상 응답된다
    const status = await secondSync.getSyncStatus();
    check('수집 상태에 lastSyncedAt 이 채워진다', status.lastSyncedAt instanceof Date, status.lastSyncedAt);
  } finally {
    await dataSource.destroy();
    const cleanup = new DataSource({ ...base, database: undefined as any });
    await cleanup.initialize();
    await cleanup.query(`DROP DATABASE IF EXISTS \`${SMOKE_DATABASE}\``);
    await cleanup.destroy();
    console.log(`\n일회용 DB(${SMOKE_DATABASE}) 정리 완료`);
  }

  if (failed > 0) {
    console.error(`\n${failed}건 실패`);
    process.exit(1);
  }
  console.log('\n전 항목 통과');
})().catch((e) => {
  console.error('SMOKE FAILED', e);
  process.exit(1);
});
