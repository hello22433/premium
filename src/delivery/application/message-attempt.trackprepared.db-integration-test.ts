import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource, Repository } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import { MessageAttemptEntity } from '../../entity/message.attempt.entity';
import { MessageAttemptChannel, MessageAttemptStatus, MessageAttemptType } from '../interface/message.attempt.status';
import { LEGACY_SEND_OP } from '../interface/delivery.workflow.status';
import { MessageAttemptService } from './message-attempt.service';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PR#32 HIGH (3차) — 실 MySQL interleaving 검증.
 *
 * `trackPreparedSend` 는 delivered 검증과 `OUTBOX_READY → SUBMITTING` 전이를
 * **workflow 행을 FOR UPDATE 로 잠근 트랜잭션 안에서** 수행해야 한다. 서브쿼리(NOT EXISTS) 결합은
 * InnoDB 가 workflow 행을 잠그지 않아 다음 순서를 막지 못했다:
 *   ① 자동 재발송이 delivered_flag=0 확인 → ② 타 채널이 delivered_flag=1 커밋 →
 *   ③ 자동 재발송이 SUBMITTING 커밋 + Gemtek 호출(중복 발송).
 * 이 테스트는 그 interleaving 을 실 DB 잠금으로 재현한다: 전달완료 기록자가 workflow 행 잠금을
 * 보유한 채 delivered 를 커밋하면, 잠금 대기 후 깨어난 trackPreparedSend 는 반드시 그 커밋을 보고
 * 발송 없이 취소 종결해야 한다.
 */
describe('MessageAttemptService.trackPreparedSend DB 동시성 (delivered 직렬화)', () => {
  let dataSource: DataSource;
  let workflowRepository: Repository<DeliveryWorkflowEntity>;
  let attemptRepository: Repository<MessageAttemptEntity>;
  let service: MessageAttemptService;

  beforeAll(async () => {
    initializeTransactionalContext();
    deleteDataSourceByName('default');

    const database = process.env.DATABASE_DATABASE;
    if (!database || !TEST_DB_NAME_PATTERN.test(database)) {
      throw new Error('DB 통합테스트는 이름에 test가 포함된 DATABASE_DATABASE에서만 실행할 수 있습니다.');
    }

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
      database,
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

    workflowRepository = dataSource.getRepository(DeliveryWorkflowEntity);
    attemptRepository = dataSource.getRepository(MessageAttemptEntity);

    // trackPreparedSend 는 attemptRepository 와 dataSource 만 쓴다(슬롯 서비스 미사용).
    service = new MessageAttemptService(attemptRepository, {} as never, dataSource);
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const seed = async (orderDeliveryId: number, attemptId: string) => {
    await workflowRepository.save(workflowRepository.create({ orderDeliveryId }));
    await attemptRepository.save(
      attemptRepository.create({
        attemptId,
        orderDeliveryId,
        channel: MessageAttemptChannel.MMS,
        attemptType: MessageAttemptType.AUTO_504,
        attemptSeq: 2,
        retryOfAttemptId: 'f'.repeat(32),
        rootAttemptId: 'f'.repeat(32),
        status: MessageAttemptStatus.OUTBOX_READY,
        createdByOp: LEGACY_SEND_OP,
        createdWorkflowVersion: '0',
      }),
    );
    return await attemptRepository.findOneByOrFail({ attemptId });
  };

  it('전달완료 기록자가 workflow 잠금을 보유·커밋하면, 대기하던 trackPreparedSend 는 발송 없이 취소 종결한다', async () => {
    const orderDeliveryId = 910001;
    const attemptId = '1'.repeat(32);
    const attempt = await seed(orderDeliveryId, attemptId);

    // 전달완료 기록자 역할: workflow 행을 FOR UPDATE 로 잠근다(markDelivered 의 UPDATE 와 동일 행).
    const writer = dataSource.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    await writer.manager
      .getRepository(DeliveryWorkflowEntity)
      .findOne({ where: { orderDeliveryId }, lock: { mode: 'pessimistic_write' } });

    // 자동 재발송 시작 — workflow 잠금 대기로 블록되어야 한다.
    const send = jest.fn().mockResolvedValue({ mseq: 1, recovered: false });
    const pending = service.trackPreparedSend(attempt, send);

    // 잠금 대기 중에는 SUBMITTING 전이가 일어나지 않아야 한다(리뷰 지적의 ①~③ interleaving 차단).
    await sleep(500);
    const midFlight = await attemptRepository.findOneByOrFail({ attemptId });
    expect(midFlight.status).toBe(MessageAttemptStatus.OUTBOX_READY);
    expect(send).not.toHaveBeenCalled();

    // 잠금 보유 중 전달완료를 기록하고 커밋한다(= 타 채널 최종 성공이 먼저 확정된 세계).
    await writer.manager.update(
      DeliveryWorkflowEntity,
      { orderDeliveryId },
      { deliveredFlag: true, deliveredChannel: MessageAttemptChannel.ALIM_TALK, deliveredAt: new Date() },
    );
    await writer.commitTransaction();
    await writer.release();

    // 잠금이 풀린 trackPreparedSend 는 반드시 그 커밋을 보고 취소 종결한다 — Gemtek 호출 없음.
    await expect(pending).resolves.toBe('SUPERSEDED');
    expect(send).not.toHaveBeenCalled();

    const row = await attemptRepository.findOneByOrFail({ attemptId });
    expect(row.status).toBe(MessageAttemptStatus.CANCELLED_SUPERSEDED);
    expect(row.resolvedAt).not.toBeNull();
  });

  it('경합이 없으면 SUBMITTING 커밋 후에만 외부 발송을 호출하고 TRACKING 으로 정착한다', async () => {
    const orderDeliveryId = 910002;
    const attemptId = '2'.repeat(32);
    const attempt = await seed(orderDeliveryId, attemptId);

    // 외부 호출 시점에 SUBMITTING 이 이미 **커밋**돼 있어야 한다(별도 커넥션으로 관찰).
    const observedAtSend: (string | undefined)[] = [];
    const send = jest.fn().mockImplementation(async () => {
      const observer = dataSource.createQueryRunner();
      await observer.connect();
      try {
        const row = await observer.manager.getRepository(MessageAttemptEntity).findOneByOrFail({ attemptId });
        observedAtSend.push(row.status);
      } finally {
        await observer.release();
      }
      return { mseq: 777, recovered: false };
    });

    await expect(service.trackPreparedSend(attempt, send)).resolves.toBe('SENT');

    expect(send).toHaveBeenCalledTimes(1);
    expect(observedAtSend).toEqual([MessageAttemptStatus.SUBMITTING]);

    const row = await attemptRepository.findOneByOrFail({ attemptId });
    expect(row.status).toBe(MessageAttemptStatus.TRACKING);
    expect(row.mseq).toBe('777');
  });

  it('trackPreparedSend 가 커밋한 뒤의 전달완료 기록은 막지 않는다 — §3 나가 수용하는 in-flight 중복 경계', async () => {
    const orderDeliveryId = 910003;
    const attemptId = '3'.repeat(32);
    const attempt = await seed(orderDeliveryId, attemptId);

    await expect(service.trackPreparedSend(attempt, async () => ({ mseq: 5, recovered: false }))).resolves.toBe('SENT');

    // SUBMITTING 커밋 이후의 delivered 기록은 정상 커밋된다(경쟁 창이 아니라 수용되는 중복 구간).
    const result = await workflowRepository.update({ orderDeliveryId }, { deliveredFlag: true });
    expect(result.affected).toBe(1);
  });
});
