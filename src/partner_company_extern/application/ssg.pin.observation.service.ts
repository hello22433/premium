import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { SsgPinObservationCandidateEntity } from '../../entity/ssg.pin.observation.candidate.entity';
import { SsgPinObservationRunEntity } from '../../entity/ssg.pin.observation.run.entity';
import { SsgPinResolution } from '../interface/ssg.issue';
import { ssgObservationBucketAt } from '../domain/ssg.autoresolve.policy';

export interface SsgPinObservationCandidateInput {
  ssgIssueLogId: number;
  tryYn: string | null;
  resultCd: string | null;
  resolution: SsgPinResolution;
}

export interface SsgPinObservationInput {
  pinIssueCommandId: string;
  orderDeliveryId: number;
  mode: string;
  aggregateResolution: SsgPinResolution;
  candidates: SsgPinObservationCandidateInput[];
  /** 관측 당시 command 스냅샷 — 사후 분석에서 정상 in-flight 표본을 제거하려면 반드시 필요하다. */
  commandSnapshot: {
    status: string;
    externalIssueCount: number;
    stateEnteredAt: Date | null;
    leaseExpiresAt: Date | null;
  };
  observedAt?: Date;
}

/**
 * EP-P30 §9-3 관측 writer.
 *
 * run + candidate 를 **한 트랜잭션**으로 쓴다. run 만 남고 candidate 가 비면 그 버킷은 UNIQUE 때문에
 * 다른 worker 도 복구하지 못하는 영구 공백이 되므로, 부분 결과를 허용하지 않는다.
 * 버킷 UNIQUE 충돌은 경합 패자이므로 정상 skip 이다(오류 아님).
 *
 * 관측은 판정의 부산물이라 실패해도 판정·발송을 막지 않는다. 예외는 여기서 흡수한다.
 */
@Injectable()
export class SsgPinObservationService {
  private readonly logger = new Logger('SSG_PIN_OBSERVATION');

  constructor(
    @InjectRepository(SsgPinObservationRunEntity)
    private readonly runRepository: Repository<SsgPinObservationRunEntity>,
  ) {}

  async record(input: SsgPinObservationInput): Promise<boolean> {
    const observedAt = input.observedAt ?? new Date();
    const bucketAt = ssgObservationBucketAt(observedAt);

    try {
      return await this.runRepository.manager.transaction(async (manager) => {
        const inserted = await manager.insert(SsgPinObservationRunEntity, {
          pinIssueCommandId: input.pinIssueCommandId,
          orderDeliveryId: input.orderDeliveryId,
          observationBucketAt: bucketAt,
          aggregateResolution: input.aggregateResolution,
          mode: input.mode,
          candidateCount: input.candidates.length,
          commandStatus: input.commandSnapshot.status,
          externalIssueCount: input.commandSnapshot.externalIssueCount,
          stateEnteredAt: input.commandSnapshot.stateEnteredAt,
          leaseExpiresAt: input.commandSnapshot.leaseExpiresAt,
          observedAt,
          completedAt: observedAt,
        });
        const runId = String(inserted.identifiers[0].id);

        if (input.candidates.length > 0) {
          await manager.insert(
            SsgPinObservationCandidateEntity,
            input.candidates.map((candidate) => ({
              runId,
              ssgIssueLogId: candidate.ssgIssueLogId,
              tryYn: candidate.tryYn,
              resultCd: candidate.resultCd,
              resolution: candidate.resolution,
            })),
          );
        }
        return true;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        // 같은 버킷을 다른 인스턴스가 이미 관측했다. 중복 3행이 "연속 3회" 로 오판되지 않도록 버린다.
        return false;
      }
      this.logger.warn(
        `[P30] 관측 기록 실패(판정에는 영향 없음). commandId=${input.pinIssueCommandId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return false;
    }
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { code?: string; errno?: number } | undefined;
  return driverError?.code === 'ER_DUP_ENTRY' || driverError?.errno === 1062;
}
