import { QueryFailedError } from 'typeorm';
import { SsgPinObservationCandidateEntity } from '../../entity/ssg.pin.observation.candidate.entity';
import { SsgPinObservationRunEntity } from '../../entity/ssg.pin.observation.run.entity';
import { SsgPinResolution } from '../interface/ssg.issue';
import { SsgPinObservationService } from './ssg.pin.observation.service';

/**
 * EP-P30 §9-3 관측 저장 원자성.
 *
 * observe 는 command/claim 을 건들지 않아 상호배제 장치가 없다. 버킷 UNIQUE 만이 다중 인스턴스
 * 중복 관측을 막고, run+candidate 를 한 트랜잭션으로 묶는 것만이 "빈 run 이 버킷을 영구 점유"를 막는다.
 */
describe('SsgPinObservationService', () => {
  const duplicateError = () => {
    const error = new QueryFailedError('INSERT', [], new Error('dup') as any);
    (error as any).driverError = { code: 'ER_DUP_ENTRY', errno: 1062 };
    return error;
  };

  const makeService = (insert: jest.Mock) => {
    const manager = { insert };
    const repository = {
      manager: {
        transaction: jest.fn(async (cb: any) => cb(manager)),
      },
    };
    return { sut: new SsgPinObservationService(repository as any), insert, repository };
  };

  const input = {
    pinIssueCommandId: '11',
    orderDeliveryId: 9001,
    mode: 'observe',
    aggregateResolution: SsgPinResolution.NOT_ISSUED,
    candidates: [{ ssgIssueLogId: 1, tryYn: 'N', resultCd: null, resolution: SsgPinResolution.NOT_ISSUED }],
    commandSnapshot: {
      status: 'OPS_REVIEW_REQUIRED',
      externalIssueCount: 1,
      stateEnteredAt: new Date('2026-08-14T09:00:00.000Z'),
      leaseExpiresAt: null,
    },
    observedAt: new Date('2026-08-14T10:07:31.500Z'),
  };

  it('run 과 candidate 를 한 트랜잭션으로 쓰고 버킷을 5분 단위로 정렬한다', async () => {
    const insert = jest.fn().mockResolvedValue({ identifiers: [{ id: '77' }] });
    const { sut } = makeService(insert);

    await expect(sut.record(input)).resolves.toBe(true);

    expect(insert).toHaveBeenNthCalledWith(
      1,
      SsgPinObservationRunEntity,
      expect.objectContaining({
        pinIssueCommandId: '11',
        candidateCount: 1,
        commandStatus: 'OPS_REVIEW_REQUIRED',
        externalIssueCount: 1,
        stateEnteredAt: input.commandSnapshot.stateEnteredAt,
        leaseExpiresAt: null,
        completedAt: input.observedAt,
        observationBucketAt: new Date('2026-08-14T10:05:00.000Z'),
      }),
    );
    expect(insert).toHaveBeenNthCalledWith(2, SsgPinObservationCandidateEntity, [
      expect.objectContaining({ runId: '77', ssgIssueLogId: 1, tryYn: 'N' }),
    ]);
  });

  it('같은 버킷 중복 관측(UNIQUE 충돌)은 오류가 아니라 정상 skip 이다', async () => {
    const insert = jest.fn().mockRejectedValue(duplicateError());
    const { sut } = makeService(insert);

    await expect(sut.record(input)).resolves.toBe(false);
  });

  it('candidate 저장이 실패하면 run 도 남기지 않는다 (부분 결과 금지)', async () => {
    const insert = jest
      .fn()
      .mockResolvedValueOnce({ identifiers: [{ id: '77' }] })
      .mockRejectedValueOnce(new Error('candidate insert failed'));
    const { sut, repository } = makeService(insert);

    await expect(sut.record(input)).resolves.toBe(false);
    // 트랜잭션 콜백이 throw 로 빠져나가 rollback 된다 — 서비스는 판정을 막지 않으려 예외를 흡수한다.
    await expect((repository.manager.transaction as jest.Mock).mock.results[0].value).rejects.toThrow(
      'candidate insert failed',
    );
  });
});
