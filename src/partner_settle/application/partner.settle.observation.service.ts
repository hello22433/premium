import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerSettleTransitionObservationEntity } from '../../entity/partner.settle.transition.observation.entity';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { IPartnerSettleSourceType } from '../interface/partner.settle.source.type';
import { buildProviderObservationKey, buildUnresolvedBaseKey } from '../domain/settle.idempotency.key';
import { KstInstant, toDbDateTimeString } from '../domain/settle.time';
import { insertRawRow, RawRow } from './partner.settle.raw.insert';

/**
 * 상태 전이 관측 (정본 §5.15.8 · PR1B 명세 B13).
 *
 * 관측은 **사실**이므로 두 형태만 있고 DB CHECK 가 그 조합을 가른다.
 * - 정상 감지 = provider 증적으로 검증된 불변 ID → `RESOLVED`. 같은 트랜잭션에서 ledger 가 append 된다.
 * - 미복원   = 전이 시퀀스를 복원 못 함 → ledger 없이 `UNRESOLVED` 보관. 해소는 PR1C 승인 2단계다.
 *
 * 재실행 중복은 `UNIQUE(observationKey)` 와 `UNIQUE(unresolvedBaseKey, unresolvedEvidenceKey)` 가 막는다.
 * **활성 UNRESOLVED 1건 제한은 두지 않는다** — E1 미해소 중 실제 새 전이 E2 가 오면 삼켜지기 때문이다.
 */

/** 재관측 수렴으로 삼켜도 되는 UNIQUE. 그 외 1062 는 삼키지 않고 그대로 올린다. */
const OBSERVATION_KEY_CONSTRAINT = 'uk_partner_settle_observation_key';
const OBSERVATION_UNRESOLVED_CONSTRAINT = 'uk_partner_settle_observation_unresolved';

export type ObservationFacts = {
  provider: IPartnerCompanyType;
  orderDeliveryId: number;
  sourceType: IPartnerSettleSourceType;
  prevStatus: string;
  newStatus: string;
  observedAt: KstInstant;
  sourceOccurredAt?: KstInstant | null;
  /** 원천이 주는 monotonic version. 없으면 NULL — 서버가 발번하지 않는다. */
  sourceVersion?: string | null;
  runId?: string | null;
};

export type ResolvedObservationInput = ObservationFacts & {
  /** 증적으로 검증된 provider 불변 ID */
  sourceEventId: string;
};

export type UnresolvedObservationInput = ObservationFacts & {
  /** 재실행에도 동일하게 재현되는 근거. snapshot-only provider 는 `INBOX:{id}` */
  evidenceKey: string;
};

@Injectable()
export class PartnerSettleObservationService {
  constructor(
    @InjectRepository(PartnerSettleTransitionObservationEntity)
    private readonly observationRepository: Repository<PartnerSettleTransitionObservationEntity>,
  ) {}

  /** 정상 감지 관측. 같은 `sourceEventId` 재관측은 기존 row 를 돌려준다(재스캔 중복 0). */
  async recordResolved(input: ResolvedObservationInput): Promise<PartnerSettleTransitionObservationEntity> {
    const observationKey = buildProviderObservationKey(input.provider, input.sourceType, input.sourceEventId);

    const existing = await this.findByObservationKey(observationKey);
    if (existing) return existing;

    await insertRawRow(
      this.observationRepository,
      'partner_settle_transition_observation',
      {
        ...this.commonColumns(input),
        source_event_id: input.sourceEventId,
        source_event_id_origin: 'PROVIDER',
        observation_key: observationKey,
        unresolved_base_key: null,
        unresolved_evidence_key: null,
        // generation 은 미복원 관측 전용이다. 정상 관측에 넣으면 CHECK 조합이 깨진다.
        generation: null,
        resolution_status: 'RESOLVED',
      },
      { idempotentConstraints: [OBSERVATION_KEY_CONSTRAINT] },
    );

    return this.requireByObservationKey(observationKey);
  }

  /**
   * 미복원 관측. 같은 evidence 재실행은 신규 row 를 만들지 않고 `lastSeenRunId` 만 갱신한다.
   *
   * `generation` 은 감사 표기 전용이라 identity 에 쓰지 않는다. 그래서 같은 baseKey 의 기존 관측 수 + 1
   * 이라는 단순 채번으로 충분하고, 값이 겹쳐도 중복 차단은 evidenceKey UNIQUE 가 담당한다.
   */
  async recordUnresolved(input: UnresolvedObservationInput): Promise<PartnerSettleTransitionObservationEntity> {
    const baseKey = buildUnresolvedBaseKey(input.provider, input.orderDeliveryId, input.sourceType);
    const observationKey = `${baseKey}:${input.evidenceKey}`;

    const existing = await this.findByObservationKey(observationKey);
    if (existing) {
      if (input.runId && existing.lastSeenRunId !== input.runId) {
        await this.observationRepository.update({ id: existing.id }, { lastSeenRunId: input.runId });
        existing.lastSeenRunId = input.runId;
      }
      return existing;
    }

    const generation = await this.observationRepository.count({ where: { unresolvedBaseKey: baseKey } });

    await insertRawRow(
      this.observationRepository,
      'partner_settle_transition_observation',
      {
        ...this.commonColumns(input),
        source_event_id: null,
        source_event_id_origin: null,
        observation_key: observationKey,
        unresolved_base_key: baseKey,
        unresolved_evidence_key: input.evidenceKey,
        generation: generation + 1,
        resolution_status: 'UNRESOLVED',
      },
      // observationKey = `${baseKey}:${evidenceKey}` 라 두 UNIQUE 는 같은 identity 를 가리킨다.
      { idempotentConstraints: [OBSERVATION_KEY_CONSTRAINT, OBSERVATION_UNRESOLVED_CONSTRAINT] },
    );

    return this.requireByObservationKey(observationKey);
  }

  private commonColumns(input: ObservationFacts): RawRow {
    return {
      order_delivery_id: input.orderDeliveryId,
      source_type: input.sourceType,
      prev_status: input.prevStatus,
      new_status: input.newStatus,
      provider: input.provider,
      // 원천 시각은 canonical 문자열로 저장한다. Date 로 넘기면 마이크로초가 잘린다.
      source_occurred_at: input.sourceOccurredAt ? toDbDateTimeString(input.sourceOccurredAt) : null,
      source_version: input.sourceVersion ?? null,
      observed_at: toDbDateTimeString(input.observedAt),
      first_seen_run_id: input.runId ?? null,
      last_seen_run_id: input.runId ?? null,
    };
  }

  private findByObservationKey(observationKey: string): Promise<PartnerSettleTransitionObservationEntity | null> {
    return this.observationRepository.findOne({ where: { observationKey } });
  }

  private async requireByObservationKey(
    observationKey: string,
  ): Promise<PartnerSettleTransitionObservationEntity> {
    const saved = await this.findByObservationKey(observationKey);
    if (!saved) {
      throw new InternalServerErrorException('전이 관측 기록 결과를 다시 읽지 못했습니다.');
    }
    return saved;
  }
}
