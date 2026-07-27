import { SmsGemtekSend } from './sms.gemtek.send';
import { GemteckMsgQueueEntity } from '../../entity/gemtek/msg.queue.entity';
import { generateAttemptId, isValidAttemptId } from '../../delivery/domain/message.attempt.id';

/**
 * Gemtek 발송 상관키(EXT_COL2) 기입 + MSEQ 캡처.
 * plans/프리미엄_발송실패_재발송_구상.md §3 다 / §5.3 / §9 Gemtek DBA 계약.
 */
describe('SmsGemtekSend — 상관키·MSEQ 추적', () => {
  const senderCode = 'SND001';

  const createService = (options: {
    insert?: jest.Mock;
    rawRows?: { mseq: number }[];
  }): {
    service: SmsGemtekSend;
    insertValues: jest.Mock;
    execute: jest.Mock;
  } => {
    const execute =
      options.insert ?? jest.fn().mockResolvedValue({ identifiers: [{ mseq: 100 }], raw: [], generatedMaps: [] });
    const insertValues = jest.fn().mockReturnValue({ execute });
    const getRawMany = jest.fn().mockResolvedValue(options.rawRows ?? []);

    const queryBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: insertValues,
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany,
    };

    const repository = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) } as never;
    const configService = { get: jest.fn().mockReturnValue(senderCode) } as never;

    return { service: new SmsGemtekSend(repository, configService), insertValues, execute };
  };

  const sendIn = (override: Partial<Parameters<SmsGemtekSend['send']>[0]> = {}) => ({
    msgType: 'M' as const,
    to: '01012345678',
    from: '025550000',
    subject: '쿠폰',
    text: '본문',
    filePath: [],
    ...override,
  });

  it('attemptId 를 EXT_COL2 에 기입하고 insert 가 반환한 MSEQ 를 돌려준다', async () => {
    const attemptId = generateAttemptId();
    const { service, insertValues } = createService({});

    const result = await service.send(sendIn({ attemptId, traceRef: '12345' }));

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ extCol2: attemptId, extCol3: '12345' }));
    expect(result).toEqual({ mseq: 100, recovered: false });
  });

  it('상관키는 하이픈 없는 hex 32자이며 매번 달라진다(추측 가능·PII 금지)', () => {
    const first = generateAttemptId();
    const second = generateAttemptId();

    expect(first).toHaveLength(32);
    expect(isValidAttemptId(first)).toBe(true);
    expect(first).not.toEqual(second);
  });

  it('attemptId 가 없으면 EXT_COL2 는 NULL 이다(legacy 발송 — 부분 unique index 무영향)', async () => {
    const { service, insertValues } = createService({});

    await service.send(sendIn());

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ extCol2: null, extCol3: null }));
  });

  it('MSEQ 를 확보하지 못해도 발송 실패로 처리하지 않고 null 로 남긴다(재조회 대상)', async () => {
    const { service } = createService({
      insert: jest.fn().mockResolvedValue({ identifiers: [], raw: [], generatedMaps: [] }),
    });

    await expect(service.send(sendIn({ attemptId: generateAttemptId() }))).resolves.toEqual({
      mseq: null,
      recovered: false,
    });
  });

  it('EXT_COL2 unique 위반은 오류가 아니라 기존 MSEQ 복구다', async () => {
    const attemptId = generateAttemptId();
    const uniqueViolation = Object.assign(new Error('Violation of UNIQUE KEY constraint'), { number: 2601 });
    const { service } = createService({
      insert: jest.fn().mockRejectedValue(uniqueViolation),
      rawRows: [{ mseq: 777 }],
    });

    await expect(service.send(sendIn({ attemptId }))).resolves.toEqual({ mseq: 777, recovered: true });
  });

  it('unique 위반인데 상관키 조회가 0건·복수면 복구하지 않고 오류를 올린다(재삽입 금지)', async () => {
    const attemptId = generateAttemptId();
    const uniqueViolation = Object.assign(new Error('Violation of UNIQUE KEY constraint'), {
      driverError: { number: 2627 },
    });
    const { service } = createService({
      insert: jest.fn().mockRejectedValue(uniqueViolation),
      rawRows: [{ mseq: 1 }, { mseq: 2 }],
    });

    await expect(service.send(sendIn({ attemptId }))).rejects.toBe(uniqueViolation);
  });

  it('unique 위반이 아닌 오류는 복구를 시도하지 않고 그대로 전파한다', async () => {
    const failure = Object.assign(new Error('timeout'), { number: -2 });
    const { service } = createService({ insert: jest.fn().mockRejectedValue(failure) });

    await expect(service.send(sendIn({ attemptId: generateAttemptId() }))).rejects.toBe(failure);
  });

  it('smsSend 경로도 EXT_COL2 를 기입하고 MSEQ 를 반환한다(insert 경로 2곳 모두 적용)', async () => {
    const attemptId = generateAttemptId();
    const { service, insertValues } = createService({});
    const queue = {
      msgType: 'S',
      dstAddr: '01012345678',
      callback: '025550000',
      text: '본문',
      extCol2: attemptId,
      extCol3: null,
    } as GemteckMsgQueueEntity;

    const result = await service.smsSend(queue);

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ extCol2: attemptId }));
    expect(result).toEqual({ mseq: 100, recovered: false });
  });
});
