/**
 * 입금내역 조회 스모크 — 로컬 dev DB(4,837건 실데이터)에 실제로 붙여 검증한다.
 *
 * 단위 테스트는 QueryBuilder 를 모킹하므로 "TypeORM 이 DATE/BIGINT 를 어떤 타입으로
 * 돌려주는가" 는 검증하지 못한다. 그 부분만 실DB 로 확인한다.
 *
 * 실행: npx ts-node -r tsconfig-paths/register <this file>
 */
import 'reflect-metadata';
import * as fs from 'fs';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { BankDepositEntity } from '../entity/bank.deposit.entity';
import { DepositService } from './application/deposit.service';
import { DepositTxType } from './interface/deposit.tx.type';
import { DepositMatchStatus } from './interface/deposit.match.status';

process.env.TZ = 'Asia/Seoul';

const ROOT = 'C:/Users/servi/IdeaProjects/epopkon-premium';

const parseEnv = (file: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

const env = parseEnv(`${ROOT}/.env.local`);

const check = (label: string, ok: boolean, detail: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${JSON.stringify(detail)}`);
  if (!ok) process.exitCode = 1;
};

(async () => {
  const dataSource = new DataSource({
    type: 'mysql',
    host: env.DATABASE_HOST,
    port: +env.DATABASE_PORT,
    username: env.DATABASE_USERNAME,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_DATABASE,
    entities: [BankDepositEntity],
    timezone: '+09:00',
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: false,
  });
  await dataSource.initialize();

  const repo = dataSource.getRepository(BankDepositEntity);
  // matched_user_id 가 전 행 NULL 이라 고객 조회 경로는 타지 않는다. 호출되면 실패로 잡는다.
  const userRepository = {
    find: async () => {
      throw new Error('matched_user_id 가 전부 NULL 인데 고객 조회가 발생했다');
    },
  } as any;
  const service = new DepositService(repo, userRepository);

  // 1) 무필터 1페이지
  const page1 = await service.getList({ page: 1, take: 5 } as any);
  check('전체 건수 4837', page1.totalCount === 4837, page1.totalCount);
  check('페이지 크기 5', page1.list.length === 5, page1.list.length);

  const first = page1.list[0];
  check('tx_date 가 yyyy-MM-dd 문자열 (하루 밀림 없음)', /^\d{4}-\d{2}-\d{2}$/.test(first.txDate as any), first.txDate);
  check('amount 가 number', typeof first.amount === 'number' && Number.isFinite(first.amount), first.amount);
  check('balance 가 number', typeof first.balance === 'number', first.balance);
  check('구분 번역됨', first.txType !== null, { txType: first.txType, label: first.txTypeLabel });
  check('미매칭 고객명은 null', first.matchedBusinessName === null, first.matchedBusinessName);

  // 2) 정렬 tie-breaker — 같은 날짜 안에서 id 내림차순
  const sorted = page1.list.every(
    (row, i) =>
      i === 0 ||
      page1.list[i - 1].txDate > row.txDate ||
      (page1.list[i - 1].txDate === row.txDate && page1.list[i - 1].id > row.id),
  );
  check(
    '정렬: txDate DESC, id DESC',
    sorted,
    page1.list.map((r) => `${r.txDate}#${r.id}`),
  );

  // 3) 페이지 경계 안정성 — take=5 로 1~3페이지를 이어 붙여 중복/누락 확인
  const ids: number[] = [];
  for (const page of [1, 2, 3]) {
    const res = await service.getList({ page, take: 5 } as any);
    ids.push(...res.list.map((r) => r.id));
  }
  check('페이지 경계 중복 없음', new Set(ids).size === ids.length, { got: ids.length, unique: new Set(ids).size });

  // 4) 구분 필터 — 실제 분포(입금 4652 / 출금 185)와 일치해야 한다
  const deposits = await service.getList({ page: 1, take: 1, txType: DepositTxType.DEPOSIT } as any);
  const withdraws = await service.getList({ page: 1, take: 1, txType: DepositTxType.WITHDRAW } as any);
  check('입금 4652건', deposits.totalCount === 4652, deposits.totalCount);
  check('출금 185건', withdraws.totalCount === 185, withdraws.totalCount);
  check('합계 = 전체', deposits.totalCount + withdraws.totalCount === page1.totalCount, {
    sum: deposits.totalCount + withdraws.totalCount,
  });

  // 5) 기간 필터 경계 포함 — 하루짜리 범위가 그 날짜만 정확히 잡히는지
  const oneDay = await service.getList({ page: 1, take: 100, startAt: first.txDate, endAt: first.txDate } as any);
  check(
    `기간 ${first.txDate} 단일일 조회가 경계를 포함`,
    oneDay.totalCount > 0 && oneDay.list.every((r) => r.txDate === first.txDate),
    { count: oneDay.totalCount },
  );

  // 6) 매칭상태 필터
  const unmatched = await service.getList({ page: 1, take: 1, matchStatus: DepositMatchStatus.UNMATCHED } as any);
  check('UNMATCHED = 전체 (매핑 미가동)', unmatched.totalCount === page1.totalCount, unmatched.totalCount);

  // 7) 입금처 부분일치
  const byDepositor = await service.getList({ page: 1, take: 5, depositor: '두성' } as any);
  check('입금처 부분일치', byDepositor.totalCount > 0 && byDepositor.list.every((r) => r.depositor.includes('두성')), {
    count: byDepositor.totalCount,
    sample: byDepositor.list[0]?.depositor,
  });

  // 8) 계좌 목록 + 그 계좌로 필터
  const accounts = await service.getAccountList();
  check(
    '계좌 6개 집계',
    accounts.accounts.length === 6,
    accounts.accounts.map((a) => `${a.accountNo}:${a.count}`),
  );
  const top = accounts.accounts[0];
  const byAccount = await service.getList({ page: 1, take: 1, accountNo: top.accountNo } as any);
  check(`계좌 필터 건수 일치 (${top.accountNo})`, byAccount.totalCount === top.count, {
    filter: byAccount.totalCount,
    agg: top.count,
  });

  // 9) 뒤집힌 기간은 400
  const reversed = await service
    .getList({ page: 1, take: 10, startAt: '2026-07-31', endAt: '2026-07-01' } as any)
    .then(() => 'no-throw')
    .catch((e) => e.constructor.name);
  check('뒤집힌 기간 → BadRequestException', reversed === 'BadRequestException', reversed);

  console.log('\n샘플 1건:', JSON.stringify(first, null, 1));

  await dataSource.destroy();
})().catch((e) => {
  console.error('SMOKE FAILED', e);
  process.exit(1);
});
