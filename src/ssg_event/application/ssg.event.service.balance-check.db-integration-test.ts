import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { addTransactionalDataSource, deleteDataSourceByName, initializeTransactionalContext } from 'typeorm-transactional';
import { SsgEventAmountHistoryEntity } from '../../entity/ssg.event.amount.history.entity';
import { SsgEventService } from './ssg.event.service';

dotenv.config();

jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;
const database = process.env.DATABASE_DATABASE;
const describeDb = database && TEST_DB_NAME_PATTERN.test(database) ? describe : describe.skip;

/**
 * getOpenTempDeductionByEvent(R) 회귀 방지 — 실 SQL 집계 검증.
 *
 * 버그: 발송확정 전 취소된 SSG 주문은 restoreEventBalance 가 복원분을 별도 row(+, isTemporary=false)로
 * 적재하고 원본 음수 차감 row(isTemporary=true)는 남긴다. R 을 (isTemporary=true AND amount<0) gross 로
 * 합산하면 이미 복원된 차감까지 영구 누적 → rho 부풀음 → A2(과다환불) 가짜경보.
 *
 * 본 테스트는 사용자 실제 사고 수치를 모사한다(진짜 살아있는 선차감 1,110,000 + 취소누적 638,485,000).
 * 수정 전이라면 R=639,595,000, 수정 후라면 R=1,110,000 이어야 한다.
 */
describeDb('SsgEventService.getOpenTempDeductionByEvent (R) DB integration', () => {
  let dataSource: DataSource;
  let amountHistoryRepository: Repository<SsgEventAmountHistoryEntity>;
  let service: SsgEventService;

  beforeAll(async () => {
    initializeTransactionalContext();
    deleteDataSourceByName('default');

    const connection = await mysql.createConnection({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      multipleStatements: false,
    });
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await connection.end();

    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: database!,
      entities: [path.join(process.cwd(), 'src/**/*.entity.ts')],
      namingStrategy: new SnakeNamingStrategy(),
      timezone: '+09:00',
      synchronize: true,
      dropSchema: true,
      logging: false,
      extra: { connectionLimit: 5 },
    });

    await dataSource.initialize();
    addTransactionalDataSource(dataSource);

    amountHistoryRepository = dataSource.getRepository(SsgEventAmountHistoryEntity);

    service = new SsgEventService(
      {} as any, // ssgEventRepository (R 계산엔 미사용)
      amountHistoryRepository,
      {} as any, // orderProductMappingRepository
      {} as any, // reservationRangeRepository
      {} as any, // recoveryLogRepository
      {} as any, // resendDeductRecoveryRepository
      {} as any, // resendDeductPendingRepository
      {} as any, // refundLedgerRepository
      {} as any, // activityLogService
      {} as any, // ssgIssue
    );
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await amountHistoryRepository.clear();
  });

  const row = (over: Partial<SsgEventAmountHistoryEntity>) =>
    amountHistoryRepository.create({ ssgEventId: 5, balance: 0, ...over });

  it('복원(취소)된 검토주문 차감은 R 에서 제외하고 살아있는 선차감만 NET 합산한다', async () => {
    await amountHistoryRepository.save([
      // 충전(orderId NULL, +, isTemporary=true 기본) → 제외
      row({ orderId: null, amount: 128_310_000, isTemporary: true }),
      // 살아있는 검토중 주문(1): 선차감만 존재 → R 에 포함
      row({ orderId: 1001, amount: -1_110_000, isTemporary: true }),
      // 취소(복원)된 검토주문(2): 원본 음수(true) + 복원분(+, false) → NET=0 → 제외
      row({ orderId: 1002, amount: -638_485_000, isTemporary: true }),
      row({ orderId: 1002, amount: 638_485_000, isTemporary: false }),
      // 확정 주문(3): 차감 row 가 isTemporary=false 로 flip → 음수 temp 미보유 → 제외
      row({ orderId: 1003, amount: -44_215_000, isTemporary: false }),
    ]);

    const R = await service.getOpenTempDeductionByEvent(5);

    // 수정 전(gross)이면 639,595,000. 수정 후(net)면 살아있는 선차감 1,110,000 만 남는다.
    expect(R).toBe(1_110_000);
  });

  it('취소가 여러 번 누적돼도 R 은 살아있는 선차감 합만 유지한다', async () => {
    await amountHistoryRepository.save([
      row({ orderId: 2001, amount: -300, isTemporary: true }),
      row({ orderId: 2002, amount: -500, isTemporary: true }),
      // 취소 누적 3건(각각 NET 0)
      row({ orderId: 3001, amount: -100, isTemporary: true }),
      row({ orderId: 3001, amount: 100, isTemporary: false }),
      row({ orderId: 3002, amount: -200, isTemporary: true }),
      row({ orderId: 3002, amount: 200, isTemporary: false }),
      row({ orderId: 3003, amount: -999_999, isTemporary: true }),
      row({ orderId: 3003, amount: 999_999, isTemporary: false }),
    ]);

    expect(await service.getOpenTempDeductionByEvent(5)).toBe(800);
  });

  it('살아있는 선차감이 없으면 0', async () => {
    await amountHistoryRepository.save([
      row({ orderId: 4001, amount: -123, isTemporary: true }),
      row({ orderId: 4001, amount: 123, isTemporary: false }),
    ]);

    expect(await service.getOpenTempDeductionByEvent(5)).toBe(0);
  });
});
